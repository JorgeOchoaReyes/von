/**
 * The slice of Firestore this platform actually uses.
 *
 * Declared here rather than importing the client's types, for two reasons.
 * Nothing in this package then depends on `@google-cloud/firestore`, so the
 * store logic — including the conditional write that keeps pool allocation
 * correct — is testable in-process against a fake, with no emulator and no
 * credentials. And the surface stays small enough to read: five methods, which
 * is a useful upper bound on how much of Firestore a future migration would
 * have to replace.
 *
 * The real client satisfies this structurally; `apps/api` adapts it at the one
 * boundary where that matters.
 */

export interface DocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface DocRef {
  readonly id: string;
  get(): Promise<DocSnapshot>;
  set(data: Record<string, unknown>): Promise<unknown>;
}

export interface QuerySnapshot {
  readonly docs: DocSnapshot[];
}

export interface Query {
  get(): Promise<QuerySnapshot>;
}

export interface Collection extends Query {
  doc(id: string): DocRef;
  where(field: string, op: "==", value: unknown): Query;
}

/**
 * A transaction. Reads must precede writes — Firestore enforces this, and the
 * fake does too, so a violation fails in tests rather than in production.
 */
export interface Transaction {
  get(ref: DocRef): Promise<DocSnapshot>;
  set(ref: DocRef, data: Record<string, unknown>): void;
}

export interface Db {
  collection(name: string): Collection;
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** Collection names, in one place so the schema is greppable. */
export const COLLECTIONS = {
  apps: "apps",
  runtimeConfigs: "runtimeConfigs",
  resources: "resources",
  pools: "pools",
  poolAssignments: "poolAssignments",
} as const;
