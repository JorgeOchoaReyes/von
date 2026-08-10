import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoUnresolvedTokens,
  generateRepo,
  PROD_BRANCH,
  render,
} from "../src/generate.ts";

const vars = {
  APP_NAME: "Trail Notes",
  APP_SLUG: "trail-notes",
  APP_ID: "app_abc123",
  BUNDLE_ID: "app.von.trailnotes",
  SCHEME: "trailnotes",
  CHANNEL: "app-abc123",
  DEFAULT_BRANCH: "main",
  EAS_PROJECT_ID: "eas-1",
  FIREBASE_PROJECT_ID: "trail-notes-abc123",
  FIRESTORE_DATABASE_ID: "(default)",
  VON_API_URL: "https://api.von.app",
};

test("substitutes tokens in contents and paths", () => {
  const files = generateRepo(
    { "apps/expo/app.json": '{"slug":"{{APP_SLUG}}"}' },
    vars,
  );
  assert.equal(files[0]!.contents, '{"slug":"trail-notes"}');
});

test("unresolved tokens fail generation rather than shipping", () => {
  const files = generateRepo({ "a.yml": "project: {{UNKNOWN_TOKEN}}" }, vars);
  assert.throws(() => assertNoUnresolvedTokens(files), /UNKNOWN_TOKEN/);
});

test("a fully substituted repo passes the guard", () => {
  const files = generateRepo(
    { "w.yml": "FIREBASE_PROJECT: {{FIREBASE_PROJECT_ID}}\nbranch: {{DEFAULT_BRANCH}}" },
    vars,
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(files));
  assert.match(files[0]!.contents, /trail-notes-abc123/);
});

test("render leaves unknown tokens intact for the guard to catch", () => {
  assert.equal(render("{{NOPE}}", vars), "{{NOPE}}");
});

test("prod branch defaults to master without the caller supplying it", () => {
  const { DEFAULT_BRANCH: _omitted, ...withoutBranch } = vars;
  const files = generateRepo(
    { "w.yml": "branches: [\"{{DEFAULT_BRANCH}}\"]" },
    withoutBranch as typeof vars,
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(files));
  assert.match(files[0]!.contents, /branches: \["master"\]/);
});

test("an explicit branch still wins over the default", () => {
  const files = generateRepo({ "w.yml": "{{DEFAULT_BRANCH}}" }, { ...vars, DEFAULT_BRANCH: "main" });
  assert.equal(files[0]!.contents, "main");
});

test("an explicitly-undefined branch still falls back to master", () => {
  // The spread-order bug: {DEFAULT_BRANCH: PROD_BRANCH, ...vars} would emit an
  // empty trigger here, silently disabling every workflow in the generated repo.
  const files = generateRepo(
    { "w.yml": 'branches: ["{{DEFAULT_BRANCH}}"]' },
    { ...vars, DEFAULT_BRANCH: undefined },
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(files));
  assert.match(files[0]!.contents, /branches: \["master"\]/);
  assert.equal(PROD_BRANCH, "master");
});

test("a value with quotes does not break the JSON it lands in", () => {
  // APP_NAME is the user's own words — the first thing they typed into the
  // chat. Written raw, `My "Todo" App` turns app.json into something that is no
  // longer JSON, and the generated repo fails at `pnpm install`.
  const files = generateRepo(
    { "app.json": '{"name":"{{APP_NAME}}","slug":"{{APP_SLUG}}"}' },
    { ...vars, APP_NAME: 'My "Todo" App \\ v2', APP_SLUG: "my-todo-app" },
  );

  const parsed = JSON.parse(files[0]!.contents) as { name: string; slug: string };
  assert.equal(parsed.name, 'My "Todo" App \\ v2');
  assert.equal(parsed.slug, "my-todo-app");
});

test("a newline in a name does not split the JSON either", () => {
  const files = generateRepo(
    { "app.json": '{"name":"{{APP_NAME}}"}' },
    { ...vars, APP_NAME: "line one\nline two" },
  );
  assert.equal((JSON.parse(files[0]!.contents) as { name: string }).name, "line one\nline two");
});

test("non-JSON files are not escaped", () => {
  // A workflow's branch trigger or a TSX string would be corrupted by JSON
  // escaping, so it applies only where it is correct.
  const files = generateRepo(
    { "ci.yml": "branches: [{{DEFAULT_BRANCH}}]", "app.tsx": "// {{APP_NAME}}" },
    { ...vars, APP_NAME: 'has "quotes"' },
  );
  assert.equal(files.find((f) => f.path === "app.tsx")!.contents, '// has "quotes"');
});
