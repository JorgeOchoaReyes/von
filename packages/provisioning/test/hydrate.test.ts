import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoHydrateDriver, type RepoCheckout } from "../src/drivers/hydrate.ts";
import type { BlueprintVars } from "@von/generator";

const BLUEPRINT = fileURLToPath(new URL("../../../templates/app-blueprint", import.meta.url));

/** An in-memory checkout, so the substitution is testable without a network. */
class FakeCheckout implements RepoCheckout {
  readonly files: Map<string, string>;
  committed: string | null = null;
  disposed = 0;
  private readonly sha: string | null;

  constructor(files: Map<string, string>, sha: string | null = "abc123") {
    this.files = files;
    this.sha = sha;
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async commitAndPush(message: string): Promise<string | null> {
    this.committed = message;
    return this.sha;
  }
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

const VARS: BlueprintVars = {
  APP_NAME: "Trail Notes",
  APP_SLUG: "trail-notes",
  APP_ID: "app_abcdefghijkl",
  BUNDLE_ID: "app.von.trailnotes",
  SCHEME: "trail-notes",
  CHANNEL: "app-abcdefghijkl",
  EAS_PROJECT_ID: "eas_proj_1",
  FIREBASE_PROJECT_ID: "von-pool-001",
  VON_API_URL: "https://api.von.test",
};

/** Every file in the real blueprint, so this test tracks the actual template. */
async function loadBlueprint(dir = BLUEPRINT, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await loadBlueprint(join(dir, entry.name), rel)) files.set(k, v);
    } else {
      files.set(rel, await readFile(join(dir, entry.name), "utf8"));
    }
  }
  return files;
}

const driverFor = (checkout: RepoCheckout) =>
  repoHydrateDriver({ branch: "master", open: async () => checkout });

test("the real blueprint hydrates with no tokens left over", async () => {
  // The guard that matters. A surviving token is a per-app value that leaked,
  // and the way that eventually shows up is one tenant's app talking to
  // another tenant's backend.
  const checkout = new FakeCheckout(await loadBlueprint());
  const out = await driverFor(checkout).create({
    appId: "app_abcdefghijkl",
    fullName: "von-apps/trail-notes",
    vars: VARS,
  });

  assert.equal(out.commitSha, "abc123");
  assert.ok(out.filesChanged > 0, "expected the blueprint to contain tokens");

  for (const [path, contents] of checkout.files) {
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(contents), `unresolved token left in ${path}`);
  }
});

test("the blueprint's own tokens are exactly the ones genesis supplies", async () => {
  // Catches the case where someone adds {{SENTRY_DSN}} to the blueprint and
  // every generated app silently ships a literal placeholder.
  const blueprint = await loadBlueprint();
  const used = new Set<string>();
  for (const contents of blueprint.values()) {
    for (const match of contents.matchAll(/\{\{([A-Z_]+)\}\}/g)) used.add(match[1]!);
  }

  const supplied = new Set([...Object.keys(VARS), "DEFAULT_BRANCH"]);
  const unknown = [...used].filter((t) => !supplied.has(t));
  assert.deepEqual(unknown, [], "blueprint uses tokens nothing supplies");
});

test("the blueprint contains an actual app, not just workflows", async () => {
  const blueprint = await loadBlueprint();
  // Regression: the blueprint was once only CI files and rules, so a generated
  // repo had nothing to install, nothing to preview and nothing to build.
  for (const required of [
    "package.json",
    "apps/expo/package.json",
    "apps/expo/app.json",
    "apps/expo/eas.json",
    "apps/expo/app/index.tsx",
    "apps/expo/src/lib/config.ts",
    "apps/expo/src/lib/firebase.ts",
    "firebase.json",
    "firestore.rules",
  ]) {
    assert.ok(blueprint.has(required), `blueprint is missing ${required}`);
  }
});

test("a token nothing supplies fails generation rather than shipping", async () => {
  const checkout = new FakeCheckout(new Map([["app.json", '{"dsn":"{{SENTRY_DSN}}"}']]));

  await assert.rejects(
    driverFor(checkout).create({
      appId: "app_1",
      fullName: "von-apps/x",
      vars: VARS,
    }),
    /SENTRY_DSN/,
  );
});

test("binary files are left alone", async () => {
  const icon = "PNG\r\n\n{{APP_NAME}}";
  const checkout = new FakeCheckout(
    new Map([
      ["apps/expo/assets/icon.png", icon],
      ["app.json", '{"name":"{{APP_NAME}}"}'],
    ]),
  );

  await driverFor(checkout).create({ appId: "a", fullName: "von-apps/x", vars: VARS });

  // Running a text substitution over image bytes corrupts them, and the failure
  // shows up as a build error about a malformed asset.
  assert.equal(checkout.files.get("apps/expo/assets/icon.png"), icon);
  assert.match(checkout.files.get("app.json") ?? "", /Trail Notes/);
});

test("an already-hydrated repo makes no second commit", async () => {
  // Re-running is safe: substitution is idempotent, so the second pass produces
  // an identical tree and commitAndPush reports nothing to do.
  const checkout = new FakeCheckout(new Map([["app.json", '{"name":"Trail Notes"}']]), null);
  const out = await driverFor(checkout).create({
    appId: "a",
    fullName: "von-apps/x",
    vars: VARS,
  });

  assert.equal(out.commitSha, null);
  assert.equal(out.filesChanged, 0);
});

test("an empty template repo fails with the cause, not a mystery", async () => {
  const checkout = new FakeCheckout(new Map());
  await assert.rejects(
    driverFor(checkout).create({ appId: "a", fullName: "von-apps/x", vars: VARS }),
    /VON_TEMPLATE_REPO/,
  );
});

test("the checkout is always disposed, including on failure", async () => {
  const ok = new FakeCheckout(new Map([["a.txt", "plain"]]));
  await driverFor(ok).create({ appId: "a", fullName: "von-apps/x", vars: VARS });
  assert.equal(ok.disposed, 1);

  const bad = new FakeCheckout(new Map([["a.txt", "{{NOPE}}"]]));
  await assert.rejects(
    driverFor(bad).create({ appId: "a", fullName: "von-apps/x", vars: VARS }),
  );
  // A customer's repository on disk in a long-lived process is a leak whether
  // or not the step succeeded.
  assert.equal(bad.disposed, 1);
});

test("the hydrated blueprint is still valid JSON", async () => {
  // Tokens live inside JSON string values. A substituted value containing a
  // quote or backslash would produce a file that parses here and fails at
  // `pnpm install` in the generated repo — far from its cause.
  const checkout = new FakeCheckout(await loadBlueprint());
  await driverFor(checkout).create({
    appId: "app_abcdefghijkl",
    fullName: "von-apps/trail-notes",
    vars: { ...VARS, APP_NAME: 'Trail "Notes" \\ Pro' },
  });

  for (const [path, contents] of checkout.files) {
    if (!path.endsWith(".json")) continue;
    assert.doesNotThrow(() => JSON.parse(contents), `${path} is not valid JSON after rendering`);
  }
});
