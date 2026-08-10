import type { Pool, PoolStore } from "@von/provisioning";
import { COLLECTIONS, type Db } from "./db.ts";

/**
 * Firestore-backed pool registry.
 *
 * `PoolStore.tryAssign` documents a requirement the in-memory version could
 * only pretend to meet: the check "is there room?" and the write "take a slot"
 * must be one atomic step. Two signups arriving together both read 99/100, both
 * decide there is room, and both commit — and the pool is over its Firestore
 * database quota, which fails app creation for *everyone* assigned to it, at
 * the worst possible moment.
 *
 * So the read and the write happen inside one transaction. Losing the race is
 * not an error: `allocatePool` simply tries the next pool.
 */
export class FirestorePoolStore implements PoolStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get pools() {
    return this.db.collection(COLLECTIONS.pools);
  }

  private get assignments() {
    return this.db.collection(COLLECTIONS.poolAssignments);
  }

  async list(): Promise<Pool[]> {
    const { docs } = await this.pools.get();
    return docs.map((d) => {
      const raw = d.data() ?? {};
      return {
        projectId: d.id,
        used: Number(raw.used ?? 0),
        capacity: Number(raw.capacity ?? 0),
        accepting: raw.accepting !== false,
      };
    });
  }

  async tryAssign(projectId: string, appId: string): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const poolRef = this.pools.doc(projectId);
      const assignRef = this.assignments.doc(appId);

      // Both reads first: Firestore forbids a read after a write in the same
      // transaction, and the assignment read is what makes a retried genesis
      // resolve to the pool it already has instead of consuming a second slot.
      const [poolSnap, assignSnap] = await Promise.all([tx.get(poolRef), tx.get(assignRef)]);

      const existing = assignSnap.data();
      if (existing) return existing.projectId === projectId;

      const pool = poolSnap.data();
      if (!pool) return false;

      const used = Number(pool.used ?? 0);
      const capacity = Number(pool.capacity ?? 0);
      if (pool.accepting === false || used >= capacity) return false;

      tx.set(poolRef, { ...pool, used: used + 1 });
      tx.set(assignRef, { appId, projectId, assignedAt: Date.now() });
      return true;
    });
  }

  async findAssignment(appId: string): Promise<string | null> {
    const snap = await this.assignments.doc(appId).get();
    const data = snap.data();
    return data ? String(data.projectId) : null;
  }

  /**
   * Register a pool project, if it is not already registered.
   *
   * Create-if-absent rather than write, because the caller is usually a
   * seed list in configuration and `used` is *live state*. Overwriting on every
   * boot would reset the occupancy count to whatever the config said, and the
   * allocator would happily fill an already-full pool past its database quota.
   *
   * Returns true if it created the record. Capacity changes and draining are
   * deliberate operator actions, not a side effect of restarting.
   */
  async register(pool: Pool): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.pools.doc(pool.projectId);
      if ((await tx.get(ref)).exists) return false;

      tx.set(ref, {
        used: pool.used,
        capacity: pool.capacity,
        accepting: pool.accepting,
      });
      return true;
    });
  }
}
