import assert from "node:assert/strict";
import { test } from "node:test";
import { allocatePool, NoPoolCapacityError } from "@von/provisioning";
import { FakeDb } from "../src/fake.ts";
import { FirestorePoolStore } from "../src/pool.ts";

async function withPools(pools: Array<[string, number, number, boolean?]>) {
  const db = new FakeDb();
  const store = new FirestorePoolStore(db);
  for (const [projectId, used, capacity, accepting] of pools) {
    await store.register({ projectId, used, capacity, accepting: accepting ?? true });
  }
  return { db, store };
}

test("registered pools come back with their capacity", async () => {
  const { store } = await withPools([["von-pool-001", 5, 100]]);
  assert.deepEqual(await store.list(), [
    { projectId: "von-pool-001", used: 5, capacity: 100, accepting: true },
  ]);
});

test("assignment takes a slot and is readable afterwards", async () => {
  const { store } = await withPools([["p1", 0, 10]]);

  assert.equal(await store.tryAssign("p1", "app_1"), true);
  assert.equal(await store.findAssignment("app_1"), "p1");
  assert.equal((await store.list())[0]!.used, 1);
});

test("a full pool refuses, without consuming a slot", async () => {
  const { store } = await withPools([["p1", 10, 10]]);

  assert.equal(await store.tryAssign("p1", "app_1"), false);
  assert.equal(await store.findAssignment("app_1"), null);
  assert.equal((await store.list())[0]!.used, 10);
});

test("a draining pool takes nothing new", async () => {
  const { store } = await withPools([["p1", 0, 10, false]]);
  assert.equal(await store.tryAssign("p1", "app_1"), false);
});

test("an unknown pool refuses rather than creating one", async () => {
  const { store } = await withPools([["p1", 0, 10]]);
  assert.equal(await store.tryAssign("p-typo", "app_1"), false);
});

test("re-running genesis reuses the assignment instead of taking a second slot", async () => {
  const { store } = await withPools([["p1", 0, 10]]);

  await store.tryAssign("p1", "app_1");
  assert.equal(await store.tryAssign("p1", "app_1"), true);

  // The whole point of stickiness: a retry after a crash must not provision a
  // second database and orphan the app's existing data.
  assert.equal((await store.list())[0]!.used, 1);
});

test("an app already homed elsewhere is not re-homed", async () => {
  const { store } = await withPools([["p1", 0, 10], ["p2", 0, 10]]);
  await store.tryAssign("p1", "app_1");

  assert.equal(await store.tryAssign("p2", "app_1"), false);
  assert.equal(await store.findAssignment("app_1"), "p1");
});

test("concurrent signups never overfill a pool", async () => {
  // The case the in-memory store could only pretend to handle: twenty requests
  // racing for five slots. A read-then-write outside a transaction lets several
  // of them see the same count and all commit.
  const { store } = await withPools([["p1", 0, 5]]);

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.tryAssign("p1", `app_${i}`)),
  );

  assert.equal(results.filter(Boolean).length, 5);
  assert.equal((await store.list())[0]!.used, 5);
});

test("allocatePool spreads across pools and stops when they are all full", async () => {
  const { store } = await withPools([["p1", 0, 2], ["p2", 0, 2]]);

  const homes = [];
  for (let i = 0; i < 4; i++) homes.push((await allocatePool(store, `app_${i}`)).projectId);

  // Emptiest-first, so the two pools fill evenly rather than one becoming a
  // hotspot while the other idles.
  assert.deepEqual(homes.sort(), ["p1", "p1", "p2", "p2"]);
  await assert.rejects(allocatePool(store, "app_overflow"), NoPoolCapacityError);
});

test("allocatePool is sticky across restarts", async () => {
  const { db, store } = await withPools([["p1", 0, 10], ["p2", 0, 10]]);
  const first = await allocatePool(store, "app_1");

  // A new process over the same database — the case that matters, since the
  // whole reason this is durable is that the control plane restarts.
  const restarted = new FirestorePoolStore(db);
  const second = await allocatePool(restarted, "app_1");

  assert.equal(second.projectId, first.projectId);
  assert.equal(second.reused, true);
});

test("re-registering a pool does not reset its occupancy", async () => {
  const { store } = await withPools([["p1", 0, 10]]);
  await store.tryAssign("p1", "app_1");
  await store.tryAssign("p1", "app_2");

  // The seed list is configuration and `used` is live state. A restart that
  // rewrote it would hand the allocator a pool it believes is empty and let it
  // fill past the Firestore database quota.
  assert.equal(await store.register({ projectId: "p1", used: 0, capacity: 10, accepting: true }), false);
  assert.equal((await store.list())[0]!.used, 2);
});

test("registering a genuinely new pool succeeds", async () => {
  const { store } = await withPools([["p1", 0, 10]]);
  assert.equal(
    await store.register({ projectId: "p2", used: 0, capacity: 10, accepting: true }),
    true,
  );
  assert.equal((await store.list()).length, 2);
});
