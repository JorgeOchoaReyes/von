import {
  App,
  newAppId,
  Release,
  slugify,
  RuntimeConfig,
  type ResourceLedger,
} from "@von/core";
import { COLLECTIONS, type Db } from "./db.ts";
import { FirestoreLedger } from "./ledger.ts";

/** What a caller supplies to create an app. */
export interface NewAppInput {
  tenantId: string;
  name: string;
  description: string;
  /**
   * Adopt an existing `owner/repo` instead of having genesis create one.
   *
   * The make/preview/publish loop only needs a repository it can clone and push
   * to — none of the backend provisioning. Adopting one makes that loop
   * testable with a GitHub token and an Anthropic key, months before there is a
   * billing account. It is also the honest path for a customer arriving with an
   * app they already have.
   */
  repoFullName?: string | null;
}

/**
 * Control-plane persistence.
 *
 * The one piece that has to be durable before any of this is real. Provisioning
 * is idempotent *because* the ledger remembers what was created; an in-memory
 * ledger means a restart mid-genesis does not resume, it re-runs — and a re-run
 * with no memory creates a *second* billable GCP project and orphans the first.
 * Losing the app list is annoying; losing the ledger costs money and leaves
 * resources nobody can find.
 */
export interface Store {
  ledger: ResourceLedger;
  createApp(input: NewAppInput): Promise<App>;
  getApp(id: string): Promise<App | null>;
  listApps(tenantId?: string): Promise<App[]>;
  updateApp(id: string, patch: Partial<App>): Promise<App>;
  putRuntimeConfig(cfg: RuntimeConfig): Promise<void>;
  getRuntimeConfig(appId: string): Promise<RuntimeConfig | null>;

  /** Record what shipped. Every publish writes one. */
  recordRelease(release: Release): Promise<void>;
  /** Newest first. */
  listReleases(appId: string, limit?: number): Promise<Release[]>;
  updateRelease(id: string, patch: Partial<Release>): Promise<Release>;
}

/** The shape of a brand-new app, in one place so both stores agree. */
export function newApp(input: NewAppInput): App {
  const now = Date.now();
  const id = newAppId();
  return {
    id,
    tenantId: input.tenantId,
    name: input.name,
    slug: slugify(input.name),
    description: input.description,
    // Pooled: usable in seconds, no GCP quota. Standalone: its own binary, so
    // one app's bad bundle cannot brick another's. Promotion to a dedicated
    // backend is an explicit later action; the web preview covers the wait for
    // the first build.
    backendTier: "pooled",
    deliveryMode: "standalone",
    firebaseProjectId: null,
    gcipTenantId: null,
    repoFullName: input.repoFullName ?? null,
    easProjectId: null,
    channel: `app-${id.slice(-12)}`,
    runtimeVersion: "1.0.0",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Firestore-backed store.
 *
 * Records are parsed back through the zod schemas on read rather than cast.
 * A document written by an older version of this code, or edited by hand in the
 * console, otherwise flows into the provisioning plan as a well-typed lie —
 * and the failure surfaces somewhere far away, as a missing project id.
 */
export class FirestoreStore implements Store {
  readonly ledger: ResourceLedger;
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.ledger = new FirestoreLedger(db);
  }

  private get apps() {
    return this.db.collection(COLLECTIONS.apps);
  }

  async createApp(input: NewAppInput): Promise<App> {
    const app = newApp(input);
    await this.apps.doc(app.id).set(app);
    return app;
  }

  async getApp(id: string): Promise<App | null> {
    const snap = await this.apps.doc(id).get();
    const data = snap.data();
    return data ? App.parse(data) : null;
  }

  async listApps(tenantId?: string): Promise<App[]> {
    const query = tenantId ? this.apps.where("tenantId", "==", tenantId) : this.apps;
    const { docs } = await query.get();
    return docs
      .map((d) => App.parse(d.data()))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateApp(id: string, patch: Partial<App>): Promise<App> {
    // A transaction rather than a bare update: provisioning writes the repo,
    // the EAS project and the tenant id from steps that finish in any order,
    // and a read-modify-write outside one loses whichever landed second.
    return this.db.runTransaction(async (tx) => {
      const ref = this.apps.doc(id);
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) throw new Error(`no app ${id}`);

      const next: App = { ...App.parse(data), ...patch, updatedAt: Date.now() };
      tx.set(ref, next);
      return next;
    });
  }

  async putRuntimeConfig(cfg: RuntimeConfig): Promise<void> {
    await this.db.collection(COLLECTIONS.runtimeConfigs).doc(cfg.appId).set(cfg);
  }

  async getRuntimeConfig(appId: string): Promise<RuntimeConfig | null> {
    const snap = await this.db.collection(COLLECTIONS.runtimeConfigs).doc(appId).get();
    const data = snap.data();
    return data ? RuntimeConfig.parse(data) : null;
  }

  private get releases() {
    return this.db.collection(COLLECTIONS.releases);
  }

  async recordRelease(release: Release): Promise<void> {
    await this.releases.doc(release.id).set(release);
  }

  async listReleases(appId: string, limit = 50): Promise<Release[]> {
    const { docs } = await this.releases.where("appId", "==", appId).get();
    return docs
      .map((d) => Release.parse(d.data()))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async updateRelease(id: string, patch: Partial<Release>): Promise<Release> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.releases.doc(id);
      const data = (await tx.get(ref)).data();
      if (!data) throw new Error(`no release ${id}`);
      const next: Release = { ...Release.parse(data), ...patch };
      tx.set(ref, next);
      return next;
    });
  }
}
