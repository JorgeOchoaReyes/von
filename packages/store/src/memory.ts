import {
  InMemoryLedger,
  type App,
  type Release,
  type ResourceLedger,
  type RuntimeConfig,
} from "@von/core";
import { newApp, type NewAppInput, type Store } from "./store.ts";

/**
 * In-memory store, for local development and tests.
 *
 * Kept beside the durable one and held to the same interface so `pnpm dev`
 * needs no credentials. It is not a fallback for production: losing the ledger
 * costs real money (see store.ts), so the control plane refuses to start
 * against it unless explicitly told to.
 */
export class InMemoryStore implements Store {
  readonly ledger: ResourceLedger = new InMemoryLedger();
  private readonly apps = new Map<string, App>();
  private readonly configs = new Map<string, RuntimeConfig>();
  private readonly releases = new Map<string, Release>();

  async createApp(input: NewAppInput): Promise<App> {
    const app = newApp(input);
    this.apps.set(app.id, app);
    return app;
  }

  async getApp(id: string): Promise<App | null> {
    return this.apps.get(id) ?? null;
  }

  async listApps(tenantId?: string): Promise<App[]> {
    const all = [...this.apps.values()].sort((a, b) => b.createdAt - a.createdAt);
    return tenantId ? all.filter((a) => a.tenantId === tenantId) : all;
  }

  async updateApp(id: string, patch: Partial<App>): Promise<App> {
    const existing = this.apps.get(id);
    if (!existing) throw new Error(`no app ${id}`);
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    this.apps.set(id, next);
    return next;
  }

  async putRuntimeConfig(cfg: RuntimeConfig): Promise<void> {
    this.configs.set(cfg.appId, cfg);
  }

  async getRuntimeConfig(appId: string): Promise<RuntimeConfig | null> {
    return this.configs.get(appId) ?? null;
  }

  async recordRelease(release: Release): Promise<void> {
    this.releases.set(release.id, release);
  }

  async listReleases(appId: string, limit = 50): Promise<Release[]> {
    return [...this.releases.values()]
      .filter((r) => r.appId === appId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async updateRelease(id: string, patch: Partial<Release>): Promise<Release> {
    const existing = this.releases.get(id);
    if (!existing) throw new Error(`no release ${id}`);
    const next = { ...existing, ...patch };
    this.releases.set(id, next);
    return next;
  }

  async incrementCrashReports(id: string): Promise<Release> {
    const existing = this.releases.get(id);
    if (!existing) throw new Error(`no release ${id}`);
    const next = { ...existing, crashReports: existing.crashReports + 1 };
    this.releases.set(id, next);
    return next;
  }
}
