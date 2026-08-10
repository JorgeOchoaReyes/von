import type { RuntimeConfig } from "@von/core";
import type { Plan, PlanContext, Step } from "../orchestrator.ts";
import {
  anonymousAuthDriver,
  deployServiceAccountDriver,
  firebaseProjectDriver,
  databaseIdFor,
  firebaseWebAppDriver,
  firestoreDriver,
  gcipTenantDriver,
  type GoogleAuth,
} from "../drivers/google.ts";
import { TerminalError } from "../driver.ts";
import { repoDriver, repoSecretsDriver, type GitHubCtx } from "../drivers/github.ts";
import { easChannelDriver, easProjectDriver, type EasCtx } from "../drivers/eas.ts";
import { repoHydrateDriver, type HydrateCtx } from "../drivers/hydrate.ts";

export interface GenesisInput extends Record<string, unknown> {
  appId: string;
  slug: string;
  displayName: string;
  description: string;
  /** `pooled` skips project creation entirely — see docs/ARCHITECTURE.md §3. */
  backendTier: "pooled" | "dedicated";
  /** `shell` skips per-app EAS project creation. */
  deliveryMode: "shell" | "standalone";
  /**
   * Pool project this app was allocated to, resolved by `allocatePool` before
   * the plan runs. Allocation is a conditional write against shared capacity,
   * which a plan step's synchronous spec thunk cannot express — and it must be
   * sticky across re-runs, so it belongs upstream of the plan, not inside it.
   */
  poolProjectId: string;
  /** Platform-owned Gemini key handed to the generated app's functions. */
  geminiApiKey: string;
  /** Expo token the generated repo's workflows use. */
  expoToken: string;
  /**
   * The app's own callback token. Written into its repository so its CI can
   * report a release outcome — and scoped to this app alone, because a
   * repository holding the platform key could act on every other customer's.
   */
  releaseToken: string;
}

export interface GenesisDeps {
  google: {
    auth: GoogleAuth;
    parent: string;
    billingAccount: string;
    /**
     * Web config of the pool project, keyed by pool project id. Pools are
     * separate Firebase projects, so each has its own web config.
     */
    poolWebConfig: (poolProjectId: string) => Record<string, string>;
    locationId: string;
  };
  github: GitHubCtx;
  eas: EasCtx;
  /** Git access for the hydrate step, injected by the control plane. */
  hydrate: HydrateCtx;
  /** Control-plane URL the generated app fetches its runtime config from. */
  apiUrl: string;
}

const isDedicated = (ctx: PlanContext) =>
  (ctx.input as GenesisInput).backendTier === "dedicated";
const isStandalone = (ctx: PlanContext) =>
  (ctx.input as GenesisInput).deliveryMode === "standalone";

const input = (ctx: PlanContext) => ctx.input as GenesisInput;

/**
 * The genesis plan — "P1: one-prompt genesis" from the founding brief.
 *
 * This is DEPLOY.md executed as code. Every step here replaces a numbered
 * instruction a human currently follows in a browser:
 *
 *   DEPLOY.md §1.1  create Firebase project        -> firebase.project
 *   DEPLOY.md §1.2  enable Anonymous auth          -> firebase.auth
 *   DEPLOY.md §1.3  create Firestore               -> firebase.firestore
 *   DEPLOY.md §1.4  upgrade to Blaze               -> firebase.project (billing)
 *   DEPLOY.md §3.1  service account + Editor role  -> firebase.serviceaccount
 *   DEPLOY.md §3.3  add GEMINI/FIREBASE secrets    -> github.secret
 *   DEPLOY.md §4.1  create Expo project            -> eas.project
 *   DEPLOY.md §4.2  paste projectId into app.json  -> generator (not a step)
 *   DEPLOY.md §5.1  add EXPO_TOKEN secret          -> github.secret
 *
 * For a pooled + standalone app — the default — seven steps run: `gcipTenant`,
 * `firestore`, `repo`, `easProject`, `easChannel`, `hydrate`, `secrets`. Every
 * step that creates or bills a GCP project is skipped until the app is
 * promoted. See test/genesis.test.ts, which asserts exactly that list.
 */
export function genesisPlan(deps: GenesisDeps): Plan {
  /**
   * The shell's EAS project, demanded only at the point a shell app needs it.
   *
   * Failing here rather than at startup keeps a standalone-only deployment
   * bootable; failing loudly rather than falling back keeps the old bug dead —
   * the fallback used to be `accountId`, which is not a project id at all.
   */
  const shellProject = (): string => {
    if (!deps.eas.shellProjectId) {
      throw new TerminalError(
        "shell delivery needs VON_SHELL_EAS_PROJECT_ID; standalone apps do not",
      );
    }
    return deps.eas.shellProjectId;
  };

  const google = {
    auth: deps.google.auth,
    parent: deps.google.parent,
    billingAccount: deps.google.billingAccount,
  };

  const steps: Step[] = [
    // -- Pooled fast path ---------------------------------------------------
    {
      id: "gcipTenant",
      driver: gcipTenantDriver(google),
      when: (ctx) => !isDedicated(ctx),
      spec: (ctx) => ({
        appId: input(ctx).appId,
        poolProjectId: input(ctx).poolProjectId,
        displayName: input(ctx).appId,
      }),
    },

    // -- Dedicated backend --------------------------------------------------
    {
      id: "firebaseProject",
      driver: firebaseProjectDriver(google),
      when: isDedicated,
      spec: (ctx) => ({
        appId: input(ctx).appId,
        // Firebase project ids are globally unique and immutable, so the app id
        // suffix removes any chance of a slug collision across tenants.
        projectId: `${input(ctx).slug}-${input(ctx).appId.slice(-6)}`,
        displayName: input(ctx).displayName,
      }),
    },
    {
      id: "firebaseWebApp",
      driver: firebaseWebAppDriver(google),
      when: isDedicated,
      needs: ["firebaseProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        projectId: ctx.outputs.firebaseProject!.projectId as string,
        displayName: input(ctx).displayName,
      }),
    },
    {
      // Runs for BOTH tiers. A dedicated app gets `(default)` in its own
      // project; a pooled app gets its own named database inside the pool
      // project. Pooled apps are not separated by a path prefix — see the
      // note on FirestoreSpec.databaseId.
      id: "firestore",
      driver: firestoreDriver(google),
      needs: ["firebaseProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        projectId: isDedicated(ctx)
          ? (ctx.outputs.firebaseProject!.projectId as string)
          : input(ctx).poolProjectId,
        locationId: deps.google.locationId,
        databaseId: isDedicated(ctx) ? "(default)" : databaseIdFor(input(ctx).appId),
      }),
    },
    {
      id: "anonAuth",
      driver: anonymousAuthDriver(google),
      when: isDedicated,
      needs: ["firebaseProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        projectId: ctx.outputs.firebaseProject!.projectId as string,
      }),
    },
    {
      id: "deploySa",
      driver: deployServiceAccountDriver(google),
      when: isDedicated,
      needs: ["firebaseProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        projectId: ctx.outputs.firebaseProject!.projectId as string,
        accountId: "von-deploy",
      }),
    },

    // -- Code + CI ----------------------------------------------------------
    {
      id: "repo",
      driver: repoDriver(deps.github),
      spec: (ctx) => ({
        appId: input(ctx).appId,
        name: `${input(ctx).slug}-${input(ctx).appId.slice(-6)}`,
        description: input(ctx).description,
        isPrivate: true,
      }),
    },

    // -- Delivery -----------------------------------------------------------
    {
      id: "easProject",
      driver: easProjectDriver(deps.eas),
      when: isStandalone,
      spec: (ctx) => ({
        appId: input(ctx).appId,
        slug: `${input(ctx).slug}-${input(ctx).appId.slice(-6)}`,
        displayName: input(ctx).displayName,
      }),
    },
    {
      id: "easChannel",
      driver: easChannelDriver(deps.eas),
      needs: ["easProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        // Standalone apps publish into their own EAS project; shell apps into
        // the shell's. Either way the channel name is derived from the app id,
        // never from anything user-supplied — for a shell app the channel is
        // the only thing separating its bundle from another tenant's.
        easProjectId:
          (ctx.outputs.easProject?.projectId as string | undefined) ?? shellProject(),
        channelName: `app-${input(ctx).appId.slice(-12)}`,
      }),
    },

    // -- Parameterisation ---------------------------------------------------
    {
      // The template copy still says `{{APP_NAME}}` everywhere. This is the
      // first real commit, and it runs after the EAS and backend steps because
      // it needs the ids they produce.
      id: "hydrate",
      driver: repoHydrateDriver(deps.hydrate),
      needs: ["repo", "easProject", "easChannel", "firebaseProject", "gcipTenant"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        fullName: ctx.outputs.repo!.fullName as string,
        vars: {
          APP_NAME: input(ctx).displayName,
          APP_SLUG: input(ctx).slug,
          APP_ID: input(ctx).appId,
          // Reverse-DNS from the platform's own domain: the customer does not
          // own a domain yet, and a bundle id is immutable once published.
          BUNDLE_ID: `app.von.${input(ctx).slug.replace(/[^a-z0-9]/g, "")}`,
          SCHEME: input(ctx).slug,
          CHANNEL: `app-${input(ctx).appId.slice(-12)}`,
          EAS_PROJECT_ID:
            (ctx.outputs.easProject?.projectId as string | undefined) ?? "",
          // The project whose Firestore rules CI deploys: the app's own for a
          // dedicated backend, the pool's for a pooled one.
          FIREBASE_PROJECT_ID:
            (ctx.outputs.firebaseProject?.projectId as string | undefined) ??
            input(ctx).poolProjectId,
          VON_API_URL: deps.apiUrl,
        },
      }),
    },

    // -- Secrets (last: needs outputs from Google *and* GitHub) -------------
    {
      id: "secrets",
      driver: repoSecretsDriver(deps.github),
      needs: ["repo", "deploySa", "easProject", "hydrate"],
      spec: (ctx) => {
        const secrets: Record<string, string> = {
          GEMINI_API_KEY: input(ctx).geminiApiKey,
          EXPO_TOKEN: input(ctx).expoToken,
          // How the app's CI reports what its release did. Without these the
          // release stays `queued` with no EAS update group, and rollback has
          // nothing to republish.
          VON_API_URL: deps.apiUrl,
          VON_RELEASE_TOKEN: input(ctx).releaseToken,
        };
        // Only dedicated apps deploy their own functions, so only they need a
        // deploy credential. Pooled apps call the shared project's functions.
        const sa = ctx.outputs.deploySa?.privateKeyJson as string | undefined;
        if (sa) secrets.FIREBASE_SERVICE_ACCOUNT = sa;
        return {
          appId: input(ctx).appId,
          fullName: ctx.outputs.repo!.fullName as string,
          secrets,
        };
      },
    },
  ];

  return { name: "genesis", steps };
}

/**
 * Resolve the runtime config an installed app fetches at boot, from whatever
 * the plan produced. Pooled and dedicated apps differ only in these values —
 * which is exactly why promotion does not require a rebuild.
 */
export function resolveRuntimeConfig(ctx: PlanContext, deps: GenesisDeps): RuntimeConfig {
  const firebase = (raw: Record<string, string>): RuntimeConfig["firebase"] => ({
    apiKey: raw.apiKey ?? "",
    authDomain: raw.authDomain ?? "",
    projectId: raw.projectId ?? "",
    storageBucket: raw.storageBucket ?? "",
    messagingSenderId: raw.messagingSenderId ?? "",
    appId: raw.appId ?? "",
  });

  const dedicated = ctx.outputs.firebaseWebApp?.config as
    | Record<string, string>
    | undefined;

  if (dedicated) {
    return {
      appId: input(ctx).appId,
      backendTier: "dedicated",
      firebase: firebase(dedicated),
      gcipTenantId: null,
      firestoreDatabaseId: "(default)",
      functionsRegion: "us-central1",
    };
  }

  const tenantId = ctx.outputs.gcipTenant?.tenantId as string | undefined;
  if (!tenantId) {
    throw new Error("no backend was provisioned: neither a web app nor a GCIP tenant");
  }

  return {
    appId: input(ctx).appId,
    backendTier: "pooled",
    firebase: firebase(deps.google.poolWebConfig(input(ctx).poolProjectId)),
    gcipTenantId: tenantId,
    // The app's own Firestore database inside the pool project: its own
    // indexes, its own rules, its own backups.
    firestoreDatabaseId: (ctx.outputs.firestore?.databaseId as string) ?? "(default)",
    functionsRegion: "us-central1",
  };
}
