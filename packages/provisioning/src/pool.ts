/**
 * Pool allocation.
 *
 * Every pooled app needs a home: a shared Firebase project with room for one
 * more Firestore database and one more GCIP tenant. Since a pool project holds
 * on the order of 100 apps (the Firestore database quota, docs/ARCHITECTURE.md
 * §5), reaching any real scale means many pools and something that decides
 * which one a new app lands in.
 *
 * Three properties matter, in this order:
 *
 *   1. **Never overfill.** Exceeding the database quota fails app creation for
 *      everyone assigned to that pool, and the failure arrives at the worst
 *      moment — a brand-new user watching their first app be created.
 *   2. **Sticky.** An app's data lives in one project forever. Re-running
 *      genesis must resolve to the same pool, or the second run provisions a
 *      second database and orphans the first.
 *   3. **Ahead of demand.** Pools are created in bulk by the platform, never on
 *      a user's critical path. The allocator's job is to notice when headroom
 *      is running low, loudly, well before it runs out.
 */

export interface Pool {
  /** GCP project id of the pool, e.g. `von-pool-004`. */
  projectId: string;
  /** Apps currently assigned. */
  used: number;
  /**
   * Max apps this pool may hold. Set below the real Firestore database quota so
   * there is room to migrate or recover without a quota increase first.
   */
  capacity: number;
  /** Drain a pool without deleting it: no new apps, existing ones untouched. */
  accepting: boolean;
}

export interface PoolStore {
  list(): Promise<Pool[]>;
  /**
   * Assign an app to a pool, incrementing `used` **atomically**. Returns false
   * if the pool filled up in between, so the caller can try the next one.
   *
   * Implementations must make this a conditional write (a Firestore
   * transaction, or `UPDATE ... WHERE used < capacity`). A read-then-write
   * would let two concurrent signups both see 99/100 and both commit.
   */
  tryAssign(projectId: string, appId: string): Promise<boolean>;
  /** The pool an app was already assigned to, if any. */
  findAssignment(appId: string): Promise<string | null>;
}

export class NoPoolCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoPoolCapacityError";
  }
}

export interface AllocateOptions {
  /**
   * Warn when free capacity across accepting pools drops below this fraction.
   * Provisioning a pool takes minutes and is a human-in-the-loop quota
   * conversation at the extreme, so the warning has to lead demand by a lot.
   */
  lowWaterMark?: number;
  onLowCapacity?: (free: number, total: number) => void;
}

export interface Allocation {
  projectId: string;
  /** True when the app already had a pool and we returned the existing one. */
  reused: boolean;
}

export async function allocatePool(
  store: PoolStore,
  appId: string,
  opts: AllocateOptions = {},
): Promise<Allocation> {
  // Sticky: an app that already has a pool always gets the same one back.
  const existing = await store.findAssignment(appId);
  if (existing) return { projectId: existing, reused: true };

  const pools = await store.list();
  const open = pools.filter((p) => p.accepting && p.used < p.capacity);

  const free = open.reduce((n, p) => n + (p.capacity - p.used), 0);
  const total = pools.reduce((n, p) => n + p.capacity, 0);
  const mark = opts.lowWaterMark ?? 0.2;
  if (total > 0 && free / total < mark) {
    opts.onLowCapacity?.(free, total);
  }

  if (open.length === 0) {
    throw new NoPoolCapacityError(
      `no pool has capacity for ${appId}: ${pools.length} pool(s), ${free} free slots. Provision another pool project.`,
    );
  }

  // Fill the emptiest pool first. Packing tightly instead would make every
  // pool a hotspot in turn and concentrate one noisy app's neighbours; spreading
  // keeps per-pool load even and leaves each pool room to absorb a spike.
  const ordered = [...open].sort(
    (a, b) => b.capacity - b.used - (a.capacity - a.used),
  );

  for (const pool of ordered) {
    // tryAssign is conditional, so losing a race here just means trying the
    // next pool rather than overfilling this one.
    if (await store.tryAssign(pool.projectId, appId)) {
      return { projectId: pool.projectId, reused: false };
    }
  }

  throw new NoPoolCapacityError(
    `every candidate pool filled while assigning ${appId}; retry`,
  );
}

/** In-memory PoolStore for tests and local development. */
export class InMemoryPoolStore implements PoolStore {
  private readonly pools: Map<string, Pool>;
  private readonly assignments = new Map<string, string>();

  constructor(pools: Pool[]) {
    this.pools = new Map(pools.map((p) => [p.projectId, { ...p }]));
  }

  async list(): Promise<Pool[]> {
    return [...this.pools.values()].map((p) => ({ ...p }));
  }

  async tryAssign(projectId: string, appId: string): Promise<boolean> {
    const pool = this.pools.get(projectId);
    if (!pool || !pool.accepting || pool.used >= pool.capacity) return false;
    pool.used++;
    this.assignments.set(appId, projectId);
    return true;
  }

  async findAssignment(appId: string): Promise<string | null> {
    return this.assignments.get(appId) ?? null;
  }
}
