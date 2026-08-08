import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffDependencies,
  isProtected,
  protectedPaths,
  InMemoryWorkspace,
} from "../src/workspace.ts";

test("pooled apps cannot edit shared rules or functions", () => {
  const locked = protectedPaths("pooled");
  for (const path of [
    "firestore.rules",
    "firebase.json",
    "functions/src/index.ts",
    "functions/package.json",
  ]) {
    assert.equal(isProtected(path, locked), true, `${path} must be locked on pooled`);
  }
});

test("pooled apps can still edit everything that is actually theirs", () => {
  const locked = protectedPaths("pooled");
  for (const path of [
    "apps/expo/app/index.tsx",
    "apps/expo/src/components/Card.tsx",
    "packages/firebase/src/types.ts",
    "apps/expo/package.json",
  ]) {
    assert.equal(isProtected(path, locked), false, `${path} must stay editable`);
  }
});

test("a dedicated app owns its whole backend", () => {
  const locked = protectedPaths("dedicated");
  assert.deepEqual(locked, []);
  assert.equal(isProtected("firestore.rules", locked), false);
  assert.equal(isProtected("functions/src/index.ts", locked), false);
});

test("prefix matching does not over-block lookalike paths", () => {
  const locked = protectedPaths("pooled");
  // "functions/" is a directory rule; a file merely starting with the word is not.
  assert.equal(isProtected("apps/expo/src/functions-helper.ts", locked), false);
  assert.equal(isProtected("firestore.rules.md", locked), false);
});

test("dependency diffing feeds the release classifier", () => {
  const before = JSON.stringify({ dependencies: { expo: "52", zod: "3" } });
  const after = JSON.stringify({ dependencies: { expo: "52", "expo-camera": "1" } });
  assert.deepEqual(diffDependencies(before, after), {
    added: ["expo-camera"],
    removed: ["zod"],
  });
});

test("workspace records exactly the touched paths", async () => {
  const ws = new InMemoryWorkspace({ "a.ts": "1" });
  await ws.write("b.ts", "2");
  await ws.read("a.ts");
  assert.deepEqual(ws.changedFiles(), ["b.ts"]);
});
