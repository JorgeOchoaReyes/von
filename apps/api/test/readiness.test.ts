import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptedRepoReadiness, checkReadiness } from "../src/readiness.ts";

const ALL = [
  "VON_FIRESTORE_PROJECT",
  "VON_API_KEYS",
  "ANTHROPIC_API_KEY",
  "GITHUB_INSTALLATION_TOKEN",
  "VON_GITHUB_ORG",
  "VON_TEMPLATE_REPO",
  "VON_PUBLIC_URL",
  "GOOGLE_ACCESS_TOKEN",
  "GCP_PARENT",
  "GCP_BILLING_ACCOUNT",
  "VON_POOLS",
  "VON_POOL_WEB_CONFIGS",
  "EXPO_TOKEN",
  "EXPO_ACCOUNT_ID",
  "EXPO_ACCOUNT_NAME",
  "VON_PREVIEW_HOST",
  "GEMINI_API_KEY",
  "VON_MIGRATION_BUCKET",
];

/** Run with exactly the given environment, restoring whatever was there. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const name of ALL) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    return fn();
  } finally {
    for (const name of ALL) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name]!;
    }
  }
}

const capability = (id: string) =>
  checkReadiness().capabilities.find((c) => c.id === id)!;

test("an empty environment is not ready, and says why for every capability", () => {
  withEnv({}, () => {
    const { ready, capabilities, blockers } = checkReadiness();
    assert.equal(ready, false);
    assert.ok(capabilities.every((c) => !c.ready));
    assert.equal(blockers.length, capabilities.length);
  });
});

test("a fully configured environment is ready", () => {
  withEnv(
    Object.fromEntries(
      ALL.map((n) => [
        n,
        n === "VON_POOLS" ? "[]" : n === "VON_POOL_WEB_CONFIGS" ? "{}" : "set",
      ]),
    ),
    () => {
      const { ready, blockers } = checkReadiness();
      assert.deepEqual(blockers, []);
      assert.equal(ready, true);
    },
  );
});

test("a capability names what its absence costs", () => {
  withEnv({}, () => {
    // The point of the endpoint: a variable name alone does not tell you
    // whether you can proceed without it.
    const google = capability("google");
    assert.match(google.unlocks, /Provisioning/);
    assert.ok(google.missing.includes("GCP_PARENT"));
  });
});

test("a partially configured capability reports only what is missing", () => {
  withEnv({ GITHUB_INSTALLATION_TOKEN: "t", VON_GITHUB_ORG: "von-apps" }, () => {
    const github = capability("github");
    assert.deepEqual(github.missing, ["VON_TEMPLATE_REPO"]);
    assert.equal(github.ready, false);
  });
});

test("whitespace is not configuration", () => {
  withEnv({ ANTHROPIC_API_KEY: "   " }, () => {
    assert.deepEqual(capability("agent").missing, ["ANTHROPIC_API_KEY"]);
  });
});

test("malformed JSON is caught here rather than deep inside genesis", () => {
  withEnv(
    {
      GOOGLE_ACCESS_TOKEN: "t",
      GCP_PARENT: "folders/1",
      GCP_BILLING_ACCOUNT: "billingAccounts/X",
      VON_POOLS: "{not json",
      VON_POOL_WEB_CONFIGS: "{}",
    },
    () => {
      const google = capability("google");
      assert.deepEqual(google.missing, []);
      assert.deepEqual(google.invalid, ["VON_POOLS is not a JSON array"]);
      assert.equal(google.ready, false, "set-but-unparseable must not read as configured");
    },
  );
});

test("valid JSON of the wrong shape is still invalid", () => {
  withEnv(
    {
      GOOGLE_ACCESS_TOKEN: "t",
      GCP_PARENT: "folders/1",
      GCP_BILLING_ACCOUNT: "billingAccounts/X",
      // An object where the allocator will call .filter on an array.
      VON_POOLS: '{"projectId":"von-pool-001"}',
      VON_POOL_WEB_CONFIGS: "{}",
    },
    () => {
      assert.deepEqual(capability("google").invalid, ["VON_POOLS is not a JSON array"]);
    },
  );
});

test("the adopted-repo loop needs two tokens, not the whole platform", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-x", GITHUB_INSTALLATION_TOKEN: "ghs_x" }, () => {
    // The cheapest useful milestone: chat -> agent -> preview -> publish
    // against a repository that already exists. No billing, no Expo, no DNS.
    assert.deepEqual(adoptedRepoReadiness(), { ready: true, missing: [] });
    assert.equal(checkReadiness().ready, false, "the full platform is still not configured");
  });
});

test("the adopted-repo loop reports precisely what it lacks", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-x" }, () => {
    assert.deepEqual(adoptedRepoReadiness(), {
      ready: false,
      missing: ["GITHUB_INSTALLATION_TOKEN"],
    });
  });
});
