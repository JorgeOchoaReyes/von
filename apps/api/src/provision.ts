import type { App } from "@von/core";
import { GitWorkspace } from "@von/agent";
import { PROD_BRANCH } from "@von/generator";
import {
  genesisPlan,
  resolveRuntimeConfig,
  runPlan,
  type GenesisDeps,
  type GenesisInput,
  allocatePool,
  type GitHubCtx,
  cachingAuth,
  detectTokenSource,
  NoGoogleCredentials,
  type GoogleAuth,
  type PlanContext,
  type PoolStore,
} from "@von/provisioning";
import type { Store } from "./store.ts";

/**
 * Wire the provisioning plan to real credentials.
 *
 * Everything here comes from the platform's own environment — the user supplies
 * none of it. That is the whole point: "type a description, get an app" cannot
 * survive an OAuth detour and a credit-card form (docs/ARCHITECTURE.md §1).
 */
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

/**
 * The platform's Google identity, resolved once and shared.
 *
 * One instance for the whole process so its token cache is shared: genesis runs
 * several Google steps concurrently, and a cache per call site would mean a
 * token exchange per step.
 *
 * Detection is async (it may read a key file, or probe the metadata server) but
 * `GoogleAuth` is not, so the detection promise is created lazily on first use
 * and awaited inside `accessToken`. That keeps a control plane with no Google
 * credentials booting normally — provisioning is one capability among several,
 * and the readiness endpoint is most useful exactly when something is missing.
 */
let googleTokens: Promise<GoogleAuth> | null = null;

export function googleAuth(): GoogleAuth {
  googleTokens ??= detectTokenSource().then((source) => {
    if (!source) throw new NoGoogleCredentials();
    console.log(`[google] authenticating as ${source.describe()}`);
    return cachingAuth(source);
  });

  return {
    accessToken: async () => {
      try {
        return await (await googleTokens!).accessToken();
      } catch (err) {
        // Cleared so a credential added after boot is picked up on the next
        // attempt rather than needing a restart — and so one failed detection
        // does not poison every later call with the same rejected promise.
        googleTokens = null;
        throw err;
      }
    },
  };
}

/** GitHub context, shared by provisioning and by the update path. */
export function githubCtx(): GitHubCtx {
  return {
    token: async () => need("GITHUB_INSTALLATION_TOKEN"),
    org: need("VON_GITHUB_ORG"),
    templateRepo: need("VON_TEMPLATE_REPO"),
  };
}

function deps(): GenesisDeps {
  return {
    google: {
      auth: googleAuth(),
      parent: need("GCP_PARENT"),
      billingAccount: need("GCP_BILLING_ACCOUNT"),
      // Web config per pool project. Pools are separate Firebase projects, so
      // each has its own; the map is seeded when a pool is provisioned.
      poolWebConfig: (poolProjectId: string) => {
        const all = JSON.parse(need("VON_POOL_WEB_CONFIGS")) as Record<
          string,
          Record<string, string>
        >;
        const cfg = all[poolProjectId];
        if (!cfg) throw new Error(`no web config registered for pool ${poolProjectId}`);
        return cfg;
      },
      locationId: process.env.GCP_LOCATION ?? "us-central1",
    },
    github: githubCtx(),
    eas: {
      token: async () => need("EXPO_TOKEN"),
      accountId: need("EXPO_ACCOUNT_ID"),
      accountName: need("EXPO_ACCOUNT_NAME"),
      // Von's shell app, if there is one. Standalone is the default delivery
      // mode, so most deployments never set this; genesis fails loudly at the
      // channel step if an app asks for shell delivery without it.
      shellProjectId: process.env.VON_SHELL_EAS_PROJECT_ID,
    },
    // Git for the hydrate step. Injected rather than imported by the
    // provisioning package, which has no business depending on the agent's
    // workspace implementation.
    hydrate: {
      branch: PROD_BRANCH,
      open: async (fullName: string, branch: string) => {
        const ws = new GitWorkspace({ fullName, token: githubCtx().token, branch });
        await ws.open();
        return ws;
      },
    },
    // Baked into every generated app as the URL it fetches its backend config
    // from at boot, so it must be the control plane's *public* address.
    apiUrl: need("VON_PUBLIC_URL"),
  };
}

/**
 * Where a promotion's export is staged, or null when the platform has nowhere
 * to put it. Optional because a deployment that never promotes needs no bucket.
 */
export function migrateCtx(): { auth: GoogleAuth; bucket: string } | null {
  const bucket = process.env.VON_MIGRATION_BUCKET?.trim();
  if (!bucket) return null;
  return { auth: googleAuth(), bucket };
}

/**
 * Run genesis for a newly created app.
 *
 * Safe to call more than once for the same app: the plan is keyed off the app
 * id and the ledger short-circuits steps that already reached `ready`, so a
 * retry after a crash resumes rather than duplicating.
 */
export async function startGenesis(
  store: Store,
  pools: PoolStore,
  app: App,
): Promise<void> {
  const d = deps();

  // Allocate a pool before the plan runs: it is a conditional write against
  // shared capacity, and it must resolve to the same pool on every re-run.
  const allocation =
    app.backendTier === "pooled"
      ? await allocatePool(pools, app.id, {
          onLowCapacity: (free, total) =>
            console.warn(`[pools] low capacity: ${free}/${total} slots free — provision another pool`),
        })
      : { projectId: "", reused: false };

  const input: GenesisInput = {
    appId: app.id,
    poolProjectId: allocation.projectId,
    slug: app.slug,
    displayName: app.name,
    description: app.description,
    backendTier: app.backendTier,
    deliveryMode: app.deliveryMode,
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    expoToken: process.env.EXPO_TOKEN ?? "",
    releaseToken: app.releaseToken,
    playServiceAccountKey: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT?.trim() || undefined,
  };

  const ctx: PlanContext = { appId: app.id, outputs: {}, input };

  await runPlan(genesisPlan(d), ctx, store.ledger, {
    onEvent: (e) => console.log(`[genesis ${app.id}] ${e.type} ${e.stepId} ${e.message ?? ""}`),
  });

  await store.putRuntimeConfig(resolveRuntimeConfig(ctx, d));

  await store.updateApp(app.id, {
    gcipTenantId: (ctx.outputs.gcipTenant?.tenantId as string) ?? null,
    firebaseProjectId: (ctx.outputs.firebaseProject?.projectId as string) ?? null,
    repoFullName: (ctx.outputs.repo?.fullName as string) ?? null,
    easProjectId: (ctx.outputs.easProject?.projectId as string) ?? null,
  });
}
