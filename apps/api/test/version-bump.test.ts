import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpNativeVersion } from "../src/update.ts";

/** A workspace that is just a map of files. */
function tree(files: Record<string, string>) {
  return {
    files,
    async read(path: string) {
      return files[path] ?? null;
    },
    async write(path: string, contents: string) {
      files[path] = contents;
    },
  };
}

const appJson = (expo: Record<string, unknown>) =>
  JSON.stringify({ expo: { name: "Trail Notes", version: "1.0.0", ...expo } }, null, 2);

function expoOf(w: ReturnType<typeof tree>) {
  return JSON.parse(w.files["apps/expo/app.json"]!).expo as {
    version: string;
    android?: { versionCode?: number; package?: string };
    name: string;
  };
}

test("the runtime version is committed, not just recorded", async () => {
  // The bug: the control plane bumped its own record and nothing wrote
  // app.json, so with `runtimeVersion: { policy: "appVersion" }` every binary
  // stayed 1.0.0. The fence that keeps a JS bundle off a binary without the
  // native module it needs never moved, and the crash the classifier exists to
  // prevent arrived anyway.
  const w = tree({ "apps/expo/app.json": appJson({}) });

  await bumpNativeVersion(w, "1.1.0", true);

  assert.equal(expoOf(w).version, "1.1.0");
});

test("Android's version code moves so a device will take the newer APK", async () => {
  const w = tree({ "apps/expo/app.json": appJson({ android: { package: "app.von.x", versionCode: 3 } }) });

  await bumpNativeVersion(w, "1.1.0", true);

  assert.equal(expoOf(w).android?.versionCode, 4);
  // The rest of the config survives the round trip.
  assert.equal(expoOf(w).android?.package, "app.von.x");
  assert.equal(expoOf(w).name, "Trail Notes");
});

test("the first build has nothing to be newer than", async () => {
  const w = tree({ "apps/expo/app.json": appJson({ android: { package: "app.von.x" } }) });

  await bumpNativeVersion(w, "1.0.0", false);

  assert.equal(expoOf(w).android?.versionCode, undefined);
  assert.equal(expoOf(w).version, "1.0.0");
});

test("a config with no android section gets one rather than throwing", async () => {
  const w = tree({ "apps/expo/app.json": appJson({}) });

  await bumpNativeVersion(w, "1.1.0", true);

  assert.equal(expoOf(w).android?.versionCode, 2);
});

test("an adopted repo without app.json still publishes", async () => {
  // Breaking a path that worked yesterday is worse than leaving that repo's
  // versioning to its owner.
  const w = tree({});

  await assert.doesNotReject(bumpNativeVersion(w, "1.1.0", true));
});

test("a malformed app.json is refused rather than overwritten", async () => {
  const w = tree({ "apps/expo/app.json": "{ not json" });

  await assert.rejects(bumpNativeVersion(w, "1.1.0", true));
});

test("app.json without an expo key is refused", async () => {
  const w = tree({ "apps/expo/app.json": JSON.stringify({ name: "wrong shape" }) });

  await assert.rejects(bumpNativeVersion(w, "1.1.0", true), /no "expo" key/);
});
