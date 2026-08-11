import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { preflight } from "../src/preflight.ts";

/**
 * These exercise the checks against stubbed provider responses. What they are
 * protecting is the *distinction* the endpoint exists to draw: skipped is not
 * failed, and a credential that authenticates is not the same as one that is
 * pointed at the right account.
 */

const realFetch = globalThis.fetch;
const saved = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** Answer by URL substring; anything unmatched is a 404. */
function routes(table: Array<[string, { status?: number; body: unknown }]>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    const hit = table.find(([frag]) => href.includes(frag));
    if (!hit) return new Response("not stubbed", { status: 404 });
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  }) as unknown as typeof fetch;
}

function only(vars: Record<string, string>) {
  for (const k of [
    "ANTHROPIC_API_KEY",
    "GITHUB_INSTALLATION_TOKEN",
    "VON_GITHUB_ORG",
    "VON_TEMPLATE_REPO",
    "EXPO_TOKEN",
    "EXPO_ACCOUNT_NAME",
    "VON_MIGRATION_BUCKET",
    "GOOGLE_PLAY_SERVICE_ACCOUNT",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_ACCESS_TOKEN",
    "GCP_PARENT",
    "GCP_BILLING_ACCOUNT",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, vars);
}

const find = (r: Awaited<ReturnType<typeof preflight>>, id: string) =>
  r.checks.find((c) => c.id === id)!;

test("an unconfigured control plane passes preflight", async () => {
  // Running the two-token loop, or nothing at all, is a supported state. If
  // this reported 'not ok' everyone would learn to ignore the endpoint.
  only({});
  routes([]);

  const result = await preflight();

  assert.equal(result.ok, true);
  assert.ok(result.checks.every((c) => c.status === "skipped"));
});

test("a rejected GitHub token is a failure, not a shrug", async () => {
  only({ GITHUB_INSTALLATION_TOKEN: "ghs_bad" });
  routes([
    ["api.github.com/user", { status: 401, body: { message: "Bad credentials" } }],
    ["installation/repositories", { status: 401, body: { message: "Bad credentials" } }],
  ]);

  const result = await preflight();

  assert.equal(result.ok, false);
  assert.match(find(result, "github").detail, /token rejected/);
});

test("a template repo that is not a template is caught before the first app", async () => {
  // Otherwise genesis fails at the repo step having already created a GCIP
  // tenant and a Firestore database for an app that will never exist.
  only({ GITHUB_INSTALLATION_TOKEN: "ghs_ok", VON_TEMPLATE_REPO: "von-apps/blueprint" });
  routes([
    ["api.github.com/user", { body: { login: "von-bot" } }],
    ["repos/von-apps/blueprint", { body: { is_template: false, default_branch: "master" } }],
  ]);

  const result = await preflight();

  assert.match(find(result, "github").detail, /not marked as a template/);
});

test("a template defaulting to main is caught", async () => {
  // Generate-from-template copies the template's branch name, and every
  // generated workflow triggers on master. The apps would build never.
  only({ GITHUB_INSTALLATION_TOKEN: "ghs_ok", VON_TEMPLATE_REPO: "von-apps/blueprint" });
  routes([
    ["api.github.com/user", { body: { login: "von-bot" } }],
    ["repos/von-apps/blueprint", { body: { is_template: true, default_branch: "main" } }],
  ]);

  assert.match(find(await preflight(), "github").detail, /must default to "master"/);
});

test("an Expo token for the wrong account fails rather than passing quietly", async () => {
  // It authenticates perfectly. It just creates projects under someone's
  // personal account, which nothing else in the system would notice.
  only({ EXPO_TOKEN: "tok", EXPO_ACCOUNT_NAME: "von-platform" });
  routes([["auth/userInfo", { body: { data: { username: "jorge" } } }]]);

  const result = await preflight();

  assert.equal(result.ok, false);
  assert.match(find(result, "expo").detail, /belongs to jorge.*von-platform/);
});

test("a matching Expo account reports who it is", async () => {
  only({ EXPO_TOKEN: "tok", EXPO_ACCOUNT_NAME: "von-platform" });
  routes([["auth/userInfo", { body: { data: { username: "von-platform" } } }]]);

  const check = find(await preflight(), "expo");

  assert.equal(check.status, "ok");
  assert.match(check.detail, /von-platform/);
});

test("a closed billing account is a failure, because projects cannot be billed to it", async () => {
  only({
    GOOGLE_ACCESS_TOKEN: "ya29.stub",
    GCP_BILLING_ACCOUNT: "billingAccounts/000-000",
  });
  routes([["cloudbilling.googleapis.com", { body: { open: false } }]]);

  const result = await preflight();

  assert.equal(result.ok, false);
  assert.match(find(result, "google").detail, /is closed/);
});

test("a Play key that is not a service account key is caught by shape", async () => {
  // Play cannot be reached before a listing exists, so shape is all there is —
  // and pasting an OAuth client id here instead is the common mistake.
  only({ GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({ type: "authorized_user" }) });
  routes([]);

  assert.match(find(await preflight(), "play").detail, /not a service account key/);
});

test("one provider being down does not hide the others", async () => {
  only({ ANTHROPIC_API_KEY: "sk-ant-ok", EXPO_TOKEN: "tok" });
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("expo.dev")) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ data: [] }));
  }) as unknown as typeof fetch;

  const result = await preflight();

  assert.equal(find(result, "agent").status, "ok");
  assert.equal(find(result, "expo").status, "failed");
});
