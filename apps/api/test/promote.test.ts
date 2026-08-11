import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStore } from "@von/store";
import { firestoreDriver } from "@von/provisioning";
import { repoHydrateDriver } from "@von/provisioning";
import { PromotionRefused, promoteApp } from "../src/promote.ts";
import type { PoolStore } from "@von/provisioning";

const pools: PoolStore = {
  async list() {
    return [];
  },
  async tryAssign() {
    return true;
  },
  async findAssignment() {
    return "von-pool-001";
  },
};

async function pooledApp(store: InMemoryStore) {
  const app = await store.createApp({
    tenantId: "t",
    name: "Trail Notes",
    description: "",
    repoFullName: "von-apps/trail-notes",
  });
  await store.putRuntimeConfig({
    appId: app.id,
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
    firestoreDatabaseId: "app-abcdefghijkl",
    functionsRegion: "us-central1",
  });
  return app;
}

test("promotion refuses until the data question is answered", async () => {
  const store = new InMemoryStore();
  const app = await pooledApp(store);

  // Promoting silently would leave every document a user created unreachable
  // from their own app.
  await assert.rejects(promoteApp(store, pools, app), (err: Error) => {
    assert.ok(err instanceof PromotionRefused);
    assert.match(err.message, /needs a decision about data/);
    return true;
  });

  // And nothing changed while refusing.
  assert.equal((await store.getApp(app.id))!.backendTier, "pooled");
});

test("an app that is already dedicated is refused", async () => {
  const store = new InMemoryStore();
  const app = await pooledApp(store);
  await store.updateApp(app.id, { backendTier: "dedicated" });

  await assert.rejects(
    promoteApp(store, pools, (await store.getApp(app.id))!, {
      acknowledgeDataReset: true,
    }),
    /already has its own Firebase project/,
  );
});

test("an app still provisioning is refused rather than half-promoted", async () => {
  const store = new InMemoryStore();
  const app = await store.createApp({ tenantId: "t", name: "Half", description: "" });

  await assert.rejects(
    promoteApp(store, pools, app, { acknowledgeDataReset: true }),
    /has not finished provisioning/,
  );
});

test("the pooled and dedicated databases are different ledger resources", () => {
  // Regression: keyed on the app id alone, the ledger would short-circuit the
  // dedicated database and promotion would report success against a project
  // that has no Firestore at all.
  const driver = firestoreDriver({
    auth: { accessToken: async () => "t" },
    parent: "folders/1",
    billingAccount: "billingAccounts/X",
  });

  const pooled = driver.key({
    appId: "app_1",
    projectId: "von-pool-001",
    databaseId: "app-abcdefghijkl",
    locationId: "us-central1",
  });
  const dedicated = driver.key({
    appId: "app_1",
    projectId: "trail-notes-abc123",
    databaseId: "(default)",
    locationId: "us-central1",
  });

  assert.notEqual(pooled, dedicated);
});

test("hydration re-runs when the backend project changes", () => {
  // The repo's workflows bake in FIREBASE_PROJECT_ID. Keyed on the app alone, a
  // promoted app would keep deploying its rules to the pool project.
  const driver = repoHydrateDriver({
    branch: "master",
    open: async () => {
      throw new Error("unused");
    },
  });

  const vars = {
    APP_NAME: "Trail Notes",
    APP_SLUG: "trail-notes",
    APP_ID: "app_1",
    BUNDLE_ID: "app.von.trailnotes",
    SCHEME: "trail-notes",
    CHANNEL: "app-1",
    EAS_PROJECT_ID: "eas_1",
    FIRESTORE_DATABASE_ID: "app-abcdefghijkl",
    VON_API_URL: "https://api.von.test",
  };

  const pooled = driver.key({
    appId: "app_1",
    fullName: "von-apps/x",
    vars: { ...vars, FIREBASE_PROJECT_ID: "von-pool-001" },
  });
  const dedicated = driver.key({
    appId: "app_1",
    fullName: "von-apps/x",
    vars: { ...vars, FIREBASE_PROJECT_ID: "trail-notes-abc123" },
  });

  assert.notEqual(pooled, dedicated);
});

test("promotion needs a decision about data, not just a flag", async () => {
  const store = new InMemoryStore();
  const app = await pooledApp(store);

  // Neither option given: the refusal names both, so the caller does not have
  // to guess which flag exists.
  await assert.rejects(promoteApp(store, pools, app), (err: Error) => {
    assert.match(err.message, /migrateData/);
    assert.match(err.message, /acknowledgeDataReset/);
    return true;
  });
});

test("asking to migrate without a bucket refuses rather than silently resetting", async () => {
  const store = new InMemoryStore();
  const app = await pooledApp(store);

  const saved = process.env.VON_MIGRATION_BUCKET;
  delete process.env.VON_MIGRATION_BUCKET;
  try {
    // The dangerous version of this would be to fall back to a reset: the
    // caller asked for their data and would be told "promoted" without it.
    await assert.rejects(
      promoteApp(store, pools, app, { migrateData: true }),
      /VON_MIGRATION_BUCKET is not configured/,
    );
    assert.equal((await store.getApp(app.id))!.backendTier, "pooled");
  } finally {
    if (saved !== undefined) process.env.VON_MIGRATION_BUCKET = saved;
  }
});
