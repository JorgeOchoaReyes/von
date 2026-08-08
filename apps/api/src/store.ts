import {
  InMemoryLedger,
  newAppId,
  slugify,
  type App,
  type ResourceLedger,
  type RuntimeConfig,
} from "@von/core";

/**
 * Control-plane persistence.
 *
 * In-memory for now so the whole platform runs with no external dependency.
 * The interface is what production swaps — Firestore in the platform's own
 * project is the natural choice, since the ledger's access pattern (get by
 * key, list by app) maps directly onto it.
 */
export interface Store {
  ledger: ResourceLedger;
  createApp(input: { tenantId: string; name: string; description: string }): Promise<App>;
  getApp(id: string): Promise<App | null>;
  listApps(tenantId?: string): Promise<App[]>;
  updateApp(id: string, patch: Partial<App>): Promise<App>;
  putRuntimeConfig(cfg: RuntimeConfig): Promise<void>;
  getRuntimeConfig(appId: string): Promise<RuntimeConfig | null>;
}

export function createStore(): Store {
  const apps = new Map<string, App>();
  const configs = new Map<string, RuntimeConfig>();
  const ledger = new InMemoryLedger();

  return {
    ledger,

    async createApp({ tenantId, name, description }) {
      const now = Date.now();
      const id = newAppId();
      const app: App = {
        id,
        tenantId,
        name,
        slug: slugify(name),
        description,
        // Every app starts pooled + shell: usable in seconds, no GCP quota,
        // no native build. Promotion is an explicit later action.
        backendTier: "pooled",
        deliveryMode: "shell",
        firebaseProjectId: null,
        gcipTenantId: null,
        repoFullName: null,
        easProjectId: null,
        channel: `app-${id.slice(-12)}`,
        runtimeVersion: "1.0.0",
        createdAt: now,
        updatedAt: now,
      };
      apps.set(id, app);
      return app;
    },

    async getApp(id) {
      return apps.get(id) ?? null;
    },

    async listApps(tenantId) {
      const all = [...apps.values()].sort((a, b) => b.createdAt - a.createdAt);
      return tenantId ? all.filter((a) => a.tenantId === tenantId) : all;
    },

    async updateApp(id, patch) {
      const existing = apps.get(id);
      if (!existing) throw new Error(`no app ${id}`);
      const next = { ...existing, ...patch, updatedAt: Date.now() };
      apps.set(id, next);
      return next;
    },

    async putRuntimeConfig(cfg) {
      configs.set(cfg.appId, cfg);
    },

    async getRuntimeConfig(appId) {
      return configs.get(appId) ?? null;
    },
  };
}
