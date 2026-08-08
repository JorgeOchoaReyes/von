import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocatePool,
  InMemoryPoolStore,
  NoPoolCapacityError,
  type Pool,
  type PoolStore,
} from "../src/pool.ts";

const pool = (projectId: string, used: number, capacity = 100): Pool => ({
  projectId,
  used,
  capacity,
  accepting: true,
});

test("a new app lands in the emptiest accepting pool", async () => {
  const store = new InMemoryPoolStore([pool("p1", 90), pool("p2", 10), pool("p3", 50)]);
  const { projectId, reused } = await allocatePool(store, "app_1");
  assert.equal(projectId, "p2");
  assert.equal(reused, false);
});

test("allocation is sticky — an app never moves project", async () => {
  const store = new InMemoryPoolStore([pool("p1", 0), pool("p2", 0)]);

  const first = await allocatePool(store, "app_1");
  // A re-run of genesis must resolve to the same pool, or it provisions a
  // second database and orphans the app's existing data.
  const second = await allocatePool(store, "app_1");

  assert.equal(second.projectId, first.projectId);
  assert.equal(second.reused, true);
});

test("a full pool is never overfilled", async () => {
  const store = new InMemoryPoolStore([pool("p1", 2, 2), pool("p2", 0, 1)]);

  assert.equal((await allocatePool(store, "app_1")).projectId, "p2");
  await assert.rejects(allocatePool(store, "app_2"), NoPoolCapacityError);
});

test("a draining pool takes no new apps but keeps its existing ones", async () => {
  const store = new InMemoryPoolStore([
    { projectId: "draining", used: 5, capacity: 100, accepting: false },
    pool("open", 90),
  ]);

  assert.equal((await allocatePool(store, "app_1")).projectId, "open");
});

test("no capacity anywhere fails loudly with a count, not silently", async () => {
  const store = new InMemoryPoolStore([pool("p1", 100, 100)]);
  await assert.rejects(allocatePool(store, "app_1"), (err: Error) => {
    assert.ok(err instanceof NoPoolCapacityError);
    assert.match(err.message, /0 free slots/);
    assert.match(err.message, /Provision another pool/);
    return true;
  });
});

test("low capacity warns well before it runs out", async () => {
  const store = new InMemoryPoolStore([pool("p1", 85), pool("p2", 90)]);
  let warned: [number, number] | null = null;

  await allocatePool(store, "app_1", {
    lowWaterMark: 0.2,
    onLowCapacity: (free, total) => {
      warned = [free, total];
    },
  });

  // 25 free of 200 = 12.5%, under the 20% mark. Provisioning a pool takes
  // minutes, so the warning has to lead demand.
  assert.deepEqual(warned, [25, 200]);
});

test("plenty of capacity does not warn", async () => {
  const store = new InMemoryPoolStore([pool("p1", 10), pool("p2", 10)]);
  let warned = false;
  await allocatePool(store, "app_1", { onLowCapacity: () => (warned = true) });
  assert.equal(warned, false);
});

test("losing an assignment race falls through to the next pool", async () => {
  // Simulates a concurrent signup taking the last slot between our read and
  // our write — the case a read-then-write allocator would get wrong.
  let firstAttempt = true;
  const racy: PoolStore = {
    async list() {
      return [pool("contested", 99), pool("spare", 50)];
    },
    async tryAssign(projectId) {
      if (projectId === "contested" && firstAttempt) {
        firstAttempt = false;
        return false; // somebody else committed first
      }
      return true;
    },
    async findAssignment() {
      return null;
    },
  };

  const { projectId } = await allocatePool(racy, "app_1");
  assert.equal(projectId, "spare");
});

test("concurrent allocations never exceed capacity", async () => {
  const store = new InMemoryPoolStore([pool("p1", 0, 5), pool("p2", 0, 5)]);

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => allocatePool(store, `app_${i}`)),
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 10, "exactly the total capacity should be allocated");

  for (const p of await store.list()) {
    assert.ok(p.used <= p.capacity, `${p.projectId} overfilled: ${p.used}/${p.capacity}`);
  }
});
