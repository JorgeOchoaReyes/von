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
