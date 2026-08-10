import {
  FirestorePoolStore,
  FirestoreStore,
  InMemoryStore,
  type Db,
  type Store,
} from "@von/store";
import { InMemoryPoolStore, type Pool, type PoolStore } from "@von/provisioning";
import { connectFirestore } from "./firestore.ts";

export type { Store };

/**
 * Choose the control plane's persistence.
 *
 * Firestore when the platform is configured for it, in-memory otherwise. The
 * fallback is deliberately loud rather than silent: an in-memory ledger means a
 * restart mid-genesis re-runs instead of resuming, and a re-run with no memory
 * creates a *second* billable GCP project and orphans the first. That is fine
 * on a laptop and expensive anywhere else, so it has to be visible in the logs
 * of anything that boots that way.
 */
export interface Persistence {
  store: Store;
  pools: PoolStore;
  durable: boolean;
}

export async function createPersistence(): Promise<Persistence> {
  const db = await connectFirestore();

  if (!db) {
    console.warn(
      "[store] no VON_FIRESTORE_PROJECT — running in memory. " +
        "Apps, the resource ledger and pool assignments are lost on restart, " +
        "and a re-run of provisioning will create duplicate cloud resources.",
    );
    return {
      store: new InMemoryStore(),
      pools: new InMemoryPoolStore(seedPools()),
      durable: false,
    };
  }

  const pools = new FirestorePoolStore(db);
  await seedDurablePools(pools);

  return { store: new FirestoreStore(db), pools, durable: true };
}

/** Pool registry seeded from configuration: `[{projectId, capacity, ...}]`. */
function seedPools(): Pool[] {
  const raw = process.env.VON_POOLS;
  if (!raw) return [];

  return (JSON.parse(raw) as Array<Partial<Pool>>).map((p) => ({
    projectId: String(p.projectId),
    used: Number(p.used ?? 0),
    capacity: Number(p.capacity ?? 100),
    accepting: p.accepting !== false,
  }));
}

/**
 * Create-if-absent, never overwrite. `used` is live state; rewriting it from
 * configuration on every boot would tell the allocator an occupied pool is
 * empty and let it fill past the Firestore database quota.
 */
async function seedDurablePools(pools: FirestorePoolStore): Promise<void> {
  for (const pool of seedPools()) {
    if (await pools.register(pool)) {
      console.log(`[pools] registered ${pool.projectId} (capacity ${pool.capacity})`);
    }
  }
}

/** Exposed for the health endpoint, which reports what it is running on. */
export type { Db };
