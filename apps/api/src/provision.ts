import type { App } from "@von/core";
import {
  genesisPlan,
  resolveRuntimeConfig,
  runPlan,
  type GenesisDeps,
  type GenesisInput,
  allocatePool,
  InMemoryPoolStore,
  type GitHubCtx,
  type PlanContext,
  type PoolStore,
} from "@von/provisioning";
import type { Store } from "./store.ts";

/**
 * Pool registry.
 *
 * In-memory for now, seeded from the environment. Production moves this behind
 * the same durable store as everything else, because `tryAssign` has to be a
 * conditional write to be safe under concurrent signups.
 */
const pools: PoolStore = new InMemoryPoolStore(
  JSON.parse(process.env.VON_POOLS ?? "[]") as Array<{
    projectId: string;
    used: number;
    capacity: number;
    accepting: boolean;
  }>,
);

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
      // Short-lived token from the platform's provisioner service account.
      // Application Default Credentials in production; a static token locally.
      auth: { accessToken: async () => need("GOOGLE_ACCESS_TOKEN") },
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
      // Von's shell app. Every pooled app's update channel is created on this
      // project, since shell-delivered apps have no EAS project of their own.
      shellProjectId: need("VON_SHELL_EAS_PROJECT_ID"),
    },
  };
}

/**
 * Run genesis for a newly created app.
 *
 * Safe to call more than once for the same app: the plan is keyed off the app
 * id and the ledger short-circuits steps that already reached `ready`, so a
 * retry after a crash resumes rather than duplicating.
 */
export async function startGenesis(store: Store, app: App): Promise<void> {
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
