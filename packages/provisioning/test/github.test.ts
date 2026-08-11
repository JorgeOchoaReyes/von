import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD_BRANCH } from "@von/generator";
import { repoDriver, type GitHubCtx } from "../src/drivers/github.ts";

const ctx: GitHubCtx = {
  token: async () => "tok",
  org: "von-apps",
  templateRepo: "von/blueprint",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stand in for the GitHub API. `fetch` is global, so this swaps it for the
 * duration of one test rather than reaching for a mocking framework.
 */
function withGitHub(
  routes: (call: Call) => { status?: number; body: unknown },
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = routes(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const generated = (defaultBranch: string) => ({
  id: 1,
  full_name: "von-apps/trail-notes-abc123",
  default_branch: defaultBranch,
  clone_url: "https://github.com/von-apps/trail-notes-abc123.git",
});

const spec = {
  appId: "app_1",
  name: "trail-notes-abc123",
  description: "log hikes",
  isPrivate: true,
};

test("a template whose default is main produces an app on master", async () => {
  // Template-generate copies the template's default branch, name and all. Left
  // as `main`, the generated app's workflows trigger on a branch that does not
  // exist and nothing ever runs — silently.
  await withGitHub(
    (call) =>
      call.url.endsWith("/rename")
        ? { body: { name: PROD_BRANCH } }
        : { body: generated("main") },
    async (calls) => {
      const out = await repoDriver(ctx).create(spec);

      const rename = calls.find((c) => c.url.endsWith("/rename"));
      assert.ok(rename, "expected the branch to be renamed");
      assert.equal(rename!.method, "POST");
      assert.deepEqual(rename!.body, { new_name: PROD_BRANCH });
      assert.match(rename!.url, /\/branches\/main\/rename$/);
      assert.equal(out.defaultBranch, PROD_BRANCH);
    },
  );
});

test("a template already on master is left alone", async () => {
  await withGitHub(
    () => ({ body: generated(PROD_BRANCH) }),
    async (calls) => {
      const out = await repoDriver(ctx).create(spec);
      assert.ok(!calls.some((c) => c.url.endsWith("/rename")), "no rename needed");
      assert.equal(out.defaultBranch, PROD_BRANCH);
    },
  );
});

test("reading an existing repo also corrects its default branch", async () => {
  // The recovery path: the create succeeded but our ledger write was lost, and
  // the rename may have been exactly what was interrupted.
  await withGitHub(
    (call) =>
      call.url.endsWith("/rename")
        ? { body: { name: PROD_BRANCH } }
        : { body: generated("main") },
    async (calls) => {
      const out = await repoDriver(ctx).read(spec);
      assert.equal(out?.defaultBranch, PROD_BRANCH);
      assert.ok(calls.some((c) => c.url.endsWith("/rename")));
    },
  );
});

test("a repo that does not exist reads as null, without renaming anything", async () => {
  await withGitHub(
    () => ({ status: 404, body: { message: "Not Found" } }),
    async (calls) => {
      assert.equal(await repoDriver(ctx).read(spec), null);
      assert.equal(calls.length, 1);
    },
  );
});

test("branch names are escaped before going into a URL", async () => {
  // Branch names may contain slashes. Interpolated raw, `release/1.0` would
  // address a different path entirely.
  await withGitHub(
    (call) =>
      call.url.includes("/rename")
        ? { body: { name: PROD_BRANCH } }
        : { body: generated("release/1.0") },
    async (calls) => {
      await repoDriver(ctx).create(spec);
      const rename = calls.find((c) => c.url.includes("/rename"))!;
      assert.match(rename.url, /\/branches\/release%2F1\.0\/rename$/);
    },
  );
});
