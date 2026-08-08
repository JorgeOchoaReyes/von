import type { RuntimeConfig } from "@von/core";
import type { Plan, PlanContext, Step } from "../orchestrator.ts";
import {
  anonymousAuthDriver,
  deployServiceAccountDriver,
  firebaseProjectDriver,
  firebaseWebAppDriver,
  firestoreDriver,
  gcipTenantDriver,
  type GoogleAuth,
} from "../drivers/google.ts";
import { repoDriver, repoSecretsDriver, type GitHubCtx } from "../drivers/github.ts";
import { easChannelDriver, easProjectDriver, type EasCtx } from "../drivers/eas.ts";

export interface GenesisInput extends Record<string, unknown> {
  appId: string;
  slug: string;
  displayName: string;
  description: string;
  /** `pooled` skips project creation entirely — see docs/ARCHITECTURE.md §3. */
  backendTier: "pooled" | "dedicated";
  /** `shell` skips per-app EAS project creation. */
  deliveryMode: "shell" | "standalone";
  /** Platform-owned Gemini key handed to the generated app's functions. */
  geminiApiKey: string;
  /** Expo token the generated repo's workflows use. */
  expoToken: string;
}

export interface GenesisDeps {
  google: {
    auth: GoogleAuth;
    parent: string;
    billingAccount: string;
    /** Shared project backing every pooled app. */
    poolProjectId: string;
    /** Web config of the shared pool project (baked once, reused by all). */
    poolWebConfig: Record<string, string>;
    locationId: string;
  };
  github: GitHubCtx;
  eas: EasCtx;
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
 * For a pooled + shell app — the default, and what a user gets seconds after
 * describing their app — only `gcip.tenant`, `github.repo` and `eas.channel`
 * actually run. The rest are skipped until the app is promoted.
 */
export function genesisPlan(deps: GenesisDeps): Plan {
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
        poolProjectId: deps.google.poolProjectId,
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
      id: "firestore",
      driver: firestoreDriver(google),
      when: isDedicated,
      needs: ["firebaseProject"],
      spec: (ctx) => ({
        appId: input(ctx).appId,
        projectId: ctx.outputs.firebaseProject!.projectId as string,
        locationId: deps.google.locationId,
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
        // Shell apps publish into the shared host project; standalone apps into
        // their own. Either way the channel name is derived from the app id.
        easProjectId:
          (ctx.outputs.easProject?.projectId as string | undefined) ??
          deps.eas.accountId,
        channelName: `app-${input(ctx).appId.slice(-12)}`,
      }),
    },

    // -- Secrets (last: needs outputs from Google *and* GitHub) -------------
    {
      id: "secrets",
      driver: repoSecretsDriver(deps.github),
      needs: ["repo", "deploySa", "easProject"],
      spec: (ctx) => {
        const secrets: Record<string, string> = {
          GEMINI_API_KEY: input(ctx).geminiApiKey,
          EXPO_TOKEN: input(ctx).expoToken,
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
      dataPrefix: "",
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
    firebase: firebase(deps.google.poolWebConfig),
    gcipTenantId: tenantId,
    // Every pooled app's data lives under its own prefix, enforced by the
    // pooled Firestore rules against the tenant claim on the caller's token.
    dataPrefix: `t/${tenantId}`,
    functionsRegion: "us-central1",
  };
}
