/**
 * The resource ledger.
 *
 * Every external thing the platform creates — a GCP project, a GitHub repo, an
 * Expo project, a repo secret — is recorded here *before* and *after* creation.
 * This is what makes provisioning safe to retry: the orchestrator asks the
 * ledger "have I already made this?" instead of asking the provider, so a
 * crash between "created in GCP" and "wrote to our DB" cannot orphan a
 * resource we then fail to bill, find, or delete.
 */

export type ResourceKind =
  | "gcp.project"
  | "gcp.billing"
  | "firebase.project"
  | "firebase.webapp"
  | "firebase.auth"
  | "firebase.firestore"
  | "firebase.serviceaccount"
  | "gcip.tenant"
  | "github.repo"
  | "github.hydrate"
  | "github.secret"
  | "eas.project"
  | "eas.channel";

export type ResourceState =
  | "planned"
  | "creating"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed";

export interface ResourceRecord {
  /**
   * Deterministic idempotency key, e.g. `firebase.project:app_abc123`.
   * Two runs of the same plan produce the same key, which is what lets a
   * retried step short-circuit instead of creating a duplicate.
   */
  key: string;
  kind: ResourceKind;
  appId: string;
  state: ResourceState;
  /** Provider-side identifier once created (project id, repo node id, ...). */
  externalId: string | null;
  /** Provider outputs other steps depend on (config blobs, URLs, ...). */
  outputs: Record<string, unknown>;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceLedger {
  get(key: string): Promise<ResourceRecord | null>;
  listByApp(appId: string): Promise<ResourceRecord[]>;
  upsert(record: ResourceRecord): Promise<void>;
}

export function newResourceRecord(
  key: string,
  kind: ResourceKind,
  appId: string,
): ResourceRecord {
  const now = Date.now();
  return {
    key,
    kind,
    appId,
    state: "planned",
    externalId: null,
    outputs: {},
    error: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** In-memory ledger. Swap for Firestore/Postgres in production. */
export class InMemoryLedger implements ResourceLedger {
  private readonly records = new Map<string, ResourceRecord>();

  async get(key: string): Promise<ResourceRecord | null> {
    return this.records.get(key) ?? null;
  }

  async listByApp(appId: string): Promise<ResourceRecord[]> {
    return [...this.records.values()].filter((r) => r.appId === appId);
  }

  async upsert(record: ResourceRecord): Promise<void> {
    this.records.set(record.key, { ...record, updatedAt: Date.now() });
  }
}
