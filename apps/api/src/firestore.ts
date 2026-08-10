import type {
  Collection,
  Db,
  DocRef,
  DocSnapshot,
  Query,
  QuerySnapshot,
  Transaction,
} from "@von/store";

/**
 * Adapting the real Firestore client to `@von/store`'s narrow `Db`.
 *
 * This file is the only place that knows the client exists. Everything above it
 * is written against five methods and tested against a fake, so the store logic
 * — including the transaction that keeps pool allocation correct — runs in CI
 * with no emulator and no credentials.
 *
 * The wrapping is thin: snapshots already match (`id`, `exists`, `data()`), so
 * only refs need carrying, because a transaction has to hand the client back
 * the object it issued rather than our wrapper.
 */

/** Structural view of the client, so nothing here imports its types. */
interface RawRef {
  id: string;
  get(): Promise<RawSnapshot>;
  set(data: Record<string, unknown>): Promise<unknown>;
}
interface RawSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface RawQuery {
  get(): Promise<{ docs: RawSnapshot[] }>;
}
interface RawCollection extends RawQuery {
  doc(id: string): RawRef;
  where(field: string, op: string, value: unknown): RawQuery;
}
interface RawTransaction {
  get(ref: RawRef): Promise<RawSnapshot>;
  set(ref: RawRef, data: Record<string, unknown>): unknown;
}
export interface RawFirestore {
  collection(name: string): RawCollection;
  runTransaction<T>(fn: (tx: RawTransaction) => Promise<T>): Promise<T>;
}

/** Our DocRef, carrying the client's own ref for transactions to pass back. */
interface WrappedRef extends DocRef {
  readonly raw: RawRef;
}

const wrapRef = (raw: RawRef): WrappedRef => ({
  raw,
  id: raw.id,
  get: () => raw.get() as Promise<DocSnapshot>,
  set: (data) => raw.set(data),
});

const wrapQuery = (raw: RawQuery): Query => ({
  async get(): Promise<QuerySnapshot> {
    return { docs: (await raw.get()).docs as DocSnapshot[] };
  },
});

export function firestoreDb(client: RawFirestore): Db {
  return {
    collection(name: string): Collection {
      const raw = client.collection(name);
      return {
        doc: (id) => wrapRef(raw.doc(id)),
        where: (field, op, value) => wrapQuery(raw.where(field, op, value)),
        get: () => wrapQuery(raw).get(),
      };
    },

    runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      return client.runTransaction(async (raw) => {
        const tx: Transaction = {
          get: (ref) => raw.get((ref as WrappedRef).raw) as Promise<DocSnapshot>,
          set: (ref, data) => void raw.set((ref as WrappedRef).raw, data),
        };
        return fn(tx);
      });
    },
  };
}

/**
 * Connect to Firestore, or return null when the platform is not configured for
 * it.
 *
 * The client is imported dynamically so a local run — or CI — never loads it.
 * `databaseId` matters: the control plane's own data lives in a named database
 * in the platform project, kept apart from anything a customer's app touches.
 */
export async function connectFirestore(): Promise<Db | null> {
  const projectId = process.env.VON_FIRESTORE_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) return null;

  const { Firestore } = await import("@google-cloud/firestore");
  const client = new Firestore({
    projectId,
    databaseId: process.env.VON_FIRESTORE_DATABASE ?? "(default)",
    ignoreUndefinedProperties: true,
  });

  return firestoreDb(client as unknown as RawFirestore);
}
