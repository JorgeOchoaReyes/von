import assert from "node:assert/strict";
import { test } from "node:test";
import { firestoreMigrateDriver } from "../src/drivers/migrate.ts";

const ctx = {
  auth: { accessToken: async () => "tok" },
  bucket: "von-migrations",
};

const spec = {
  appId: "app_1",
  fromProjectId: "von-pool-001",
  fromDatabaseId: "app-abcdefghijkl",
  toProjectId: "trail-notes-abc123",
  toDatabaseId: "(default)",
};

interface Call {
  url: string;
  body: any;
}

/** Stand in for the Firestore admin API, including its long-running operations. */
function withFirestore(
  routes: (call: Call, n: number) => { status?: number; body: unknown },
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let n = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = routes(call, n++);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

test("data is exported from the pooled database and imported into the new one", async () => {
  await withFirestore(
    (call) => {
      if (call.url.includes(":exportDocuments")) return { body: { name: "op/export" } };
      if (call.url.includes(":importDocuments")) return { body: { name: "op/import" } };
      if (call.url.endsWith("op/export")) {
        // Firestore writes into a timestamped subdirectory and reports it.
        return { body: { done: true, response: { outputUriPrefix: "gs://b/x/2026-01-01" } } };
      }
      return { body: { done: true, response: {} } };
    },
    async (calls) => {
      const out = await firestoreMigrateDriver(ctx).create(spec);

      const exp = calls.find((c) => c.url.includes(":exportDocuments"))!;
      assert.match(exp.url, /projects\/von-pool-001\/databases\/app-abcdefghijkl/);
      assert.equal(exp.body.outputUriPrefix, "gs://von-migrations/migrations/app_1/(default)");

      const imp = calls.find((c) => c.url.includes(":importDocuments"))!;
      assert.match(imp.url, /projects\/trail-notes-abc123\/databases\/\(default\)/);
      // The *reported* location, not the prefix we asked for: importing the
      // prefix would fail, or pick up an older export sitting beside it.
      assert.equal(imp.body.inputUriPrefix, "gs://b/x/2026-01-01");
      assert.equal(out.documentsUri, "gs://b/x/2026-01-01");
    },
  );
});

test("a failed export never becomes an import", async () => {
  await withFirestore(
    (call) => {
      if (call.url.includes(":exportDocuments")) return { body: { name: "op/export" } };
      return { body: { done: true, error: { message: "permission denied" } } };
    },
    async (calls) => {
      await assert.rejects(
        firestoreMigrateDriver(ctx).create(spec),
        /permission denied/,
      );
      // Importing nothing would report success against an empty database.
      assert.ok(!calls.some((c) => c.url.includes(":importDocuments")));
    },
  );
});

test("an export that reports no location fails rather than guessing one", async () => {
  await withFirestore(
    (call) => {
      if (call.url.includes(":exportDocuments")) return { body: { name: "op/export" } };
      return { body: { done: true, response: {} } };
    },
    async () => {
      await assert.rejects(
        firestoreMigrateDriver(ctx).create(spec),
        /no output location/,
      );
    },
  );
});

test("a migration is keyed by both ends, so re-promoting does not re-export", () => {
  const driver = firestoreMigrateDriver(ctx);
  assert.equal(driver.key(spec), driver.key({ ...spec }));
  assert.notEqual(
    driver.key(spec),
    driver.key({ ...spec, toProjectId: "somewhere-else" }),
  );
});

test("a timeout is retryable, because the copy is still running server-side", async () => {
  await withFirestore(
    (call) => {
      if (call.url.includes(":exportDocuments")) return { body: { name: "op/export" } };
      return { body: { done: false } };
    },
    async () => {
      await assert.rejects(
        firestoreMigrateDriver(ctx, 10).create(spec),
        /may still be running/,
      );
    },
  );
});
