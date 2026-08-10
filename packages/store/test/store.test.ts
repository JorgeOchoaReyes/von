import assert from "node:assert/strict";
import { test } from "node:test";
import { newResourceRecord, type RuntimeConfig } from "@von/core";
import { FakeDb } from "../src/fake.ts";
import { FirestoreStore } from "../src/store.ts";
import { COLLECTIONS } from "../src/db.ts";

const make = () => {
  const db = new FakeDb();
  return { db, store: new FirestoreStore(db) };
};

const config = (appId: string): RuntimeConfig => ({
  appId,
  backendTier: "pooled",
  firebase: {
    apiKey: "k",
    authDomain: "a",
    projectId: "von-pool-001",
    storageBucket: "b",
    messagingSenderId: "1",
    appId: "1:1:web:1",
  },
  gcipTenantId: "tenant-1",
  firestoreDatabaseId: "app-abc",
  functionsRegion: "us-central1",
});

test("an app survives the round trip through storage", async () => {
  const { store } = make();
  const created = await store.createApp({
    tenantId: "tnt_1",
    name: "Trail Notes",
    description: "log hikes",
  });

  const read = await store.getApp(created.id);
  assert.deepEqual(read, created);
  assert.equal(read!.slug, "trail-notes");
  assert.equal(read!.backendTier, "pooled");
  assert.equal(read!.deliveryMode, "standalone");
});

test("a missing app is null, not a throw", async () => {
  const { store } = make();
  assert.equal(await store.getApp("app_nope"), null);
});

test("apps list newest first and filter by tenant", async () => {
  const { store } = make();
  const a = await store.createApp({ tenantId: "t1", name: "A", description: "" });
  const b = await store.createApp({ tenantId: "t2", name: "B", description: "" });
  await store.updateApp(a.id, { createdAt: 1 });
  await store.updateApp(b.id, { createdAt: 2 });

  assert.deepEqual((await store.listApps()).map((x) => x.id), [b.id, a.id]);
  assert.deepEqual((await store.listApps("t1")).map((x) => x.id), [a.id]);
});

test("concurrent provisioning writes do not clobber each other", async () => {
  const { store } = make();
  const app = await store.createApp({ tenantId: "t", name: "A", description: "" });

  // Genesis writes the repo, the EAS project and the tenant id from steps that
  // finish in any order. Outside a transaction, whichever landed second would
  // erase the others.
  await Promise.all([
    store.updateApp(app.id, { repoFullName: "von-apps/a" }),
    store.updateApp(app.id, { easProjectId: "eas_1" }),
    store.updateApp(app.id, { gcipTenantId: "tenant_1" }),
  ]);

  const read = await store.getApp(app.id);
  assert.equal(read!.repoFullName, "von-apps/a");
  assert.equal(read!.easProjectId, "eas_1");
  assert.equal(read!.gcipTenantId, "tenant_1");
});

test("updating an app that does not exist fails loudly", async () => {
  const { store } = make();
  await assert.rejects(store.updateApp("app_nope", { channel: "x" }), /no app app_nope/);
});

test("a corrupt document is rejected at the boundary, not passed on", async () => {
  const { db, store } = make();
  // Hand-edited in the console, or written by an older schema. Casting it would
  // send a well-typed lie into the provisioning plan, and the failure would
  // surface far away as a missing project id.
  await db.collection(COLLECTIONS.apps).doc("app_bad").set({ id: "app_bad", name: 5 });

  await assert.rejects(store.getApp("app_bad"));
});

test("runtime config round-trips and is missing before provisioning", async () => {
  const { store } = make();
  assert.equal(await store.getRuntimeConfig("app_1"), null);

  await store.putRuntimeConfig(config("app_1"));
  const read = await store.getRuntimeConfig("app_1");
  assert.equal(read!.gcipTenantId, "tenant-1");
  assert.equal(read!.firestoreDatabaseId, "app-abc");
});

test("the ledger remembers a created resource across a restart", async () => {
  const { db, store } = make();
  const record = newResourceRecord("firebase.project:app_1", "firebase.project", "app_1");
  await store.ledger.upsert({ ...record, state: "ready", externalId: "proj-1" });

  // A restart is a new store over the same database. Without this, a re-run
  // creates a *second* billable project and orphans the first.
  const restarted = new FirestoreStore(db);
  const found = await restarted.ledger.get("firebase.project:app_1");
  assert.equal(found?.state, "ready");
  assert.equal(found?.externalId, "proj-1");
});

test("ledger keys with separators stay a single document", async () => {
  const { db, store } = make();
  // `github.secret:app_1/EXPO_TOKEN` contains a slash, which would otherwise
  // split into a subcollection path and silently address a different document.
  const key = "github.secret:app_1/EXPO_TOKEN";
  await store.ledger.upsert(newResourceRecord(key, "github.secret", "app_1"));

  assert.equal((await store.ledger.get(key))?.key, key);
  assert.equal(db.dump(COLLECTIONS.resources).length, 1);
});

test("the ledger lists everything provisioned for one app", async () => {
  const { store } = make();
  await store.ledger.upsert(newResourceRecord("gcip.tenant:app_1", "gcip.tenant", "app_1"));
  await store.ledger.upsert(newResourceRecord("github.repo:app_1", "github.repo", "app_1"));
  await store.ledger.upsert(newResourceRecord("github.repo:app_2", "github.repo", "app_2"));

  const mine = await store.ledger.listByApp("app_1");
  assert.equal(mine.length, 2);
  assert.ok(mine.every((r) => r.appId === "app_1"));
});

test("an app can adopt an existing repository", async () => {
  const { store } = make();
  const app = await store.createApp({
    tenantId: "t",
    name: "Adopted",
    description: "",
    repoFullName: "von-apps/existing",
  });

  // Adopting skips provisioning entirely: the make/preview/publish loop needs
  // only a repo it can clone and push to, so this is the loop's cheapest path
  // to being testable — a GitHub token and an Anthropic key, nothing else.
  assert.equal(app.repoFullName, "von-apps/existing");
  assert.equal((await store.getApp(app.id))!.repoFullName, "von-apps/existing");
});

test("an app created without a repository has none until genesis writes one", async () => {
  const { store } = make();
  const app = await store.createApp({ tenantId: "t", name: "Fresh", description: "" });
  assert.equal(app.repoFullName, null);
});
