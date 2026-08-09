import type {
  Collection,
  Db,
  DocRef,
  DocSnapshot,
  Query,
  QuerySnapshot,
  Transaction,
} from "./db.ts";

/**
 * An in-process stand-in for Firestore.
 *
 * Not a mock — a working implementation, so the store logic under test is the
 * same code that runs in production and only the storage underneath differs.
 * Two behaviours are modelled deliberately because the code depends on them:
 *
 *   - **Transactions serialise.** `runTransaction` holds a lock, so a
 *     read-then-write inside one cannot interleave with another's. This is what
 *     makes the pool allocator's "never overfill" property testable at all; a
 *     fake that ignored transactions would pass a broken allocator.
 *   - **Reads precede writes.** Firestore rejects a read after a write in the
 *     same transaction. So does this, so the violation surfaces in a test.
 *
 * Documents are deep-copied in and out, so a caller mutating a returned object
 * cannot silently corrupt the store — the same isolation a real round trip
 * through serialisation gives you.
 */

const clone = <T,>(v: T): T => structuredClone(v);

interface Store {
  docs: Map<string, Record<string, unknown>>;
}

class FakeSnapshot implements DocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  private readonly value: Record<string, unknown> | undefined;

  constructor(id: string, value: Record<string, unknown> | undefined) {
    this.id = id;
    this.exists = value !== undefined;
    this.value = value;
  }

  data(): Record<string, unknown> | undefined {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

class FakeDocRef implements DocRef {
  readonly id: string;
  readonly store: Store;

  constructor(store: Store, id: string) {
    this.store = store;
    this.id = id;
  }

  async get(): Promise<DocSnapshot> {
    return new FakeSnapshot(this.id, this.store.docs.get(this.id));
  }

  async set(data: Record<string, unknown>): Promise<unknown> {
    this.store.docs.set(this.id, clone(data));
    return undefined;
  }
}

class FakeQuery implements Query {
  private readonly store: Store;
  private readonly filters: Array<[string, unknown]>;

  constructor(store: Store, filters: Array<[string, unknown]> = []) {
    this.store = store;
    this.filters = filters;
  }

  async get(): Promise<QuerySnapshot> {
    const docs: DocSnapshot[] = [];
    for (const [id, value] of this.store.docs) {
      if (this.filters.every(([field, want]) => value[field] === want)) {
        docs.push(new FakeSnapshot(id, value));
      }
    }
    return { docs };
  }
}

class FakeCollection extends FakeQuery implements Collection {
  private readonly backing: Store;

  constructor(store: Store) {
    super(store);
    this.backing = store;
  }

  doc(id: string): DocRef {
    return new FakeDocRef(this.backing, id);
  }

  where(field: string, _op: "==", value: unknown): Query {
    return new FakeQuery(this.backing, [[field, value]]);
  }
}

export class FakeDb implements Db {
  private readonly collections = new Map<string, Store>();
  /** Serialises transactions, standing in for Firestore's isolation. */
  private lock: Promise<unknown> = Promise.resolve();
  /** Counts committed transactions — lets tests assert a write actually ran. */
  transactions = 0;

  collection(name: string): Collection {
    let store = this.collections.get(name);
    if (!store) {
      store = { docs: new Map() };
      this.collections.set(name, store);
    }
    return new FakeCollection(store);
  }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const writes: Array<[FakeDocRef, Record<string, unknown>]> = [];
      let wrote = false;

      const tx: Transaction = {
        async get(ref) {
          if (wrote) {
            throw new Error("Firestore transactions require all reads before any writes");
          }
          return (ref as FakeDocRef).get();
        },
        set(ref, data) {
          wrote = true;
          writes.push([ref as FakeDocRef, data]);
        },
      };

      const result = await fn(tx);
      // Commit only after the body succeeds: a thrown transaction leaves
      // nothing behind, which is the property retries rely on.
      for (const [ref, data] of writes) await ref.set(data);
      this.transactions++;
      return result;
    });

    // The lock must advance even when this transaction throws, or one failure
    // deadlocks every later one.
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Test helper: raw contents of a collection. */
  dump(name: string): Record<string, unknown>[] {
    return [...(this.collections.get(name)?.docs.values() ?? [])].map(clone);
  }
}
