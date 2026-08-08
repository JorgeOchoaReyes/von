import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChange, nextRuntimeVersion } from "../src/classify.ts";

test("screen-only edits ship over the air", () => {
  const d = classifyChange({
    files: ["apps/expo/app/index.tsx", "apps/expo/src/components/LessonCard.tsx"],
  });
  assert.equal(d.kind, "ota");
  assert.equal(d.requiresRuntimeBump, false);
});

test("app.json edits force a native build", () => {
  const d = classifyChange({ files: ["apps/expo/app.json"] });
  assert.equal(d.kind, "native");
  assert.equal(d.requiresRuntimeBump, true);
  assert.match(d.triggers[0]!, /app\.json/);
});

test("adding an expo-* dependency forces a native build", () => {
  const d = classifyChange({
    files: ["apps/expo/package.json", "apps/expo/app/index.tsx"],
    addedDependencies: ["expo-camera"],
  });
  assert.equal(d.kind, "native");
  assert.match(d.triggers.join(" "), /expo-camera/);
});

test("adding a known JS-only dependency stays OTA", () => {
  const d = classifyChange({
    files: ["apps/expo/app/index.tsx"],
    addedDependencies: ["date-fns"],
  });
  assert.equal(d.kind, "ota");
});

test("unknown dependencies are treated as native, not guessed", () => {
  const d = classifyChange({
    files: ["apps/expo/app/index.tsx"],
    addedDependencies: ["some-obscure-package"],
  });
  assert.equal(d.kind, "native");
  assert.match(d.triggers.join(" "), /unknown dependency/);
});

test("functions-only changes are neither OTA nor native", () => {
  const d = classifyChange({ files: ["functions/src/index.ts", "firestore.rules"] });
  assert.equal(d.kind, "none");
  assert.match(d.reason, /Backend-only/);
});

test("workflow and docs edits produce no release", () => {
  const d = classifyChange({
    files: [".github/workflows/ci.yml", "README.md"],
  });
  assert.equal(d.kind, "none");
});

test("a mixed diff resolves to the strictest requirement", () => {
  const d = classifyChange({
    files: ["apps/expo/app/index.tsx", "functions/src/index.ts", "apps/expo/eas.json"],
  });
  assert.equal(d.kind, "native");
});

test("runtime version only moves when a rebuild is required", () => {
  const ota = classifyChange({ files: ["apps/expo/app/index.tsx"] });
  const native = classifyChange({ files: ["apps/expo/app.json"] });
  assert.equal(nextRuntimeVersion("1.4.0", ota), "1.4.0");
  assert.equal(nextRuntimeVersion("1.4.0", native), "1.5.0");
});
