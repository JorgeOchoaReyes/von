import type { App } from "@von/core";
import {
  genesisPlan,
  resolveRuntimeConfig,
  runPlan,
  type GenesisDeps,
  type GenesisInput,
  type PlanContext,
} from "@von/provisioning";
import type { Store } from "./store.ts";

/**
 * Wire the provisioning plan to real credentials.
 *
 * Everything here comes from the platform's own environment — the user supplies
 * none of it. That is the whole point: "type a description, get an app" cannot
 * survive an OAuth detour and a credit-card form (docs/ARCHITECTURE.md §1).
 */
function deps(): GenesisDeps {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`missing env ${name}`);
    return v;
  };

  return {
    google: {
      // Short-lived token from the platform's provisioner service account.
      // Application Default Credentials in production; a static token locally.
      auth: { accessToken: async () => need("GOOGLE_ACCESS_TOKEN") },
      parent: need("GCP_PARENT"),
      billingAccount: need("GCP_BILLING_ACCOUNT"),
      poolProjectId: need("VON_POOL_PROJECT_ID"),
      poolWebConfig: JSON.parse(need("VON_POOL_WEB_CONFIG")),
      locationId: process.env.GCP_LOCATION ?? "us-central1",
    },
    github: {
      token: async () => need("GITHUB_INSTALLATION_TOKEN"),
      org: need("VON_GITHUB_ORG"),
      templateRepo: need("VON_TEMPLATE_REPO"),
    },
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

  const input: GenesisInput = {
    appId: app.id,
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
