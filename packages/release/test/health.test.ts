import assert from "node:assert/strict";
import { test } from "node:test";
import type { Release } from "@von/core";
import { assessHealth, attributeCrash } from "../src/health.ts";

let clock = 1_000;

function release(overrides: Partial<Release> = {}): Release {
  clock += 1_000;
  return {
    id: `rel_${clock}`,
    appId: "app_1",
    kind: "ota",
    reason: "JS only",
    channel: "app-abcdefghijkl",
    runtimeVersion: "1.0.0",
    status: "succeeded",
    externalId: `group_${clock}`,
    artifactUrl: null,
    commitSha: "abc123",
    instruction: "add a screen",
    rolledBackBy: null,
    isRollback: false,
    crashReports: 0,
    createdAt: clock,
    ...overrides,
  };
}

test("an update group names an exact bundle", () => {
  const older = release({ id: "rel_a", externalId: "group_a" });
  const newer = release({ id: "rel_b", externalId: "group_b" });

  // Not the newest — the one the device is actually running.
  const blamed = attributeCrash([older, newer], {
    runtimeVersion: "1.0.0",
    updateGroup: "group_a",
  });
  assert.equal(blamed?.id, "rel_a");
});

test("without a group, the newest release on that runtime version is blamed", () => {
  const older = release({ id: "rel_a" });
  const newer = release({ id: "rel_b" });

  // Coarse on purpose: a device may not have applied the newest update yet, so
  // this resolves to the release those devices *could* be running.
  const blamed = attributeCrash([older, newer], { runtimeVersion: "1.0.0" });
  assert.equal(blamed?.id, "rel_b");
});

test("a signal from a different runtime version is dropped, not guessed", () => {
  // Attributing it anywhere would put a crash count on a bundle that is fine,
  // and invite undoing it.
  assert.equal(attributeCrash([release()], { runtimeVersion: "2.0.0" }), null);
});

test("an unknown group falls back to the runtime version rather than dropping", () => {
  const only = release({ id: "rel_a", externalId: "group_a" });
  const blamed = attributeCrash([only], {
    runtimeVersion: "1.0.0",
    updateGroup: "group_that_never_existed",
  });
  assert.equal(blamed?.id, "rel_a");
});

test("an app with no releases attributes nothing", () => {
  assert.equal(attributeCrash([], { runtimeVersion: "1.0.0" }), null);
});

test("one report is noise; a handful is a pattern", () => {
  const good = release({ id: "rel_a" });

  assert.equal(assessHealth([good, release({ crashReports: 1 })]).suspect, false);
  assert.equal(assessHealth([good, release({ crashReports: 3 })]).suspect, true);
});

test("health reports the undo option alongside the problem", () => {
  const good = release({ id: "rel_good" });
  const bad = release({ id: "rel_bad", crashReports: 9 });

  // Both halves in one answer: a UI that asks separately ends up showing a
  // button that fails when pressed.
  const health = assessHealth([good, bad]);
  assert.equal(health.latest?.id, "rel_bad");
  assert.equal(health.crashReports, 9);
  assert.equal(health.suspect, true);
  assert.deepEqual(health.rollback, { available: true, to: "rel_good", reason: null });
});

test("when undo is impossible, health says why in the same breath", () => {
  // Order of construction is order of createdAt, so the native build has to be
  // built *after* the other for it to be the release under scrutiny.
  const earlier = release();
  const native = release({ id: "rel_native", kind: "native", crashReports: 10 });

  const health = assessHealth([earlier, native]);
  assert.equal(health.suspect, true);
  assert.equal(health.rollback.available, false);
  assert.match(health.rollback.reason ?? "", /needs a new build/);
});

test("an app that never published is healthy and has nothing to undo", () => {
  const health = assessHealth([]);
  assert.equal(health.latest, null);
  assert.equal(health.crashReports, 0);
  assert.equal(health.suspect, false);
  assert.equal(health.rollback.available, false);
  assert.match(health.rollback.reason ?? "", /never been published/);
});

test("the install link comes from the last native build, not the last release", () => {
  // The failure this prevents: an OTA is the newest release and has no artifact
  // of its own, so reading the link off `latest` shows nothing to install for an
  // app that has a perfectly good binary.
  const build = release({
    kind: "native",
    artifactUrl: "https://expo.dev/artifacts/eas/abc.apk",
    runtimeVersion: "1.1.0",
  });
  const ota = release({ runtimeVersion: "1.1.0" });

  const health = assessHealth([build, ota]);

  assert.equal(health.latest?.id, ota.id);
  assert.equal(health.install?.url, "https://expo.dev/artifacts/eas/abc.apk");
  assert.equal(health.install?.releaseId, build.id);
});

test("a build that failed is not offered as an install", () => {
  // The workflow reports back whatever happened, so a failed run can still
  // carry a URL. Linking to it is worse than linking to nothing.
  const failed = release({ kind: "native", status: "failed", artifactUrl: "https://x/broken.apk" });

  assert.equal(assessHealth([failed]).install, null);
});

test("a build in flight is reported while the old link still stands", () => {
  const shipped = release({
    kind: "native",
    artifactUrl: "https://expo.dev/artifacts/eas/old.apk",
  });
  const inFlight = release({ kind: "native", status: "queued", artifactUrl: null });

  const health = assessHealth([shipped, inFlight]);

  // Both are true at once, and the UI needs both: there is something to install,
  // and it is not the change that was just published.
  assert.equal(health.install?.url, "https://expo.dev/artifacts/eas/old.apk");
  assert.equal(health.building, true);
});

test("an app with nothing built has no install and is not building", () => {
  const health = assessHealth([release()]);

  assert.equal(health.install, null);
  assert.equal(health.building, false);
});

test("a store submission is never offered as an install link", () => {
  // Its artifact is an Android App Bundle. Play unpacks one into per-device
  // APKs; handed to a person directly it is a file their phone will not open.
  const bundle = release({
    kind: "store",
    artifactUrl: "https://expo.dev/artifacts/eas/app.aab",
  });

  const health = assessHealth([bundle]);

  assert.equal(health.install, null);
  assert.equal(health.submitting, false);
});

test("an APK still wins the install link when a newer bundle exists", () => {
  const apk = release({ kind: "native", artifactUrl: "https://x/app.apk" });
  const aab = release({ kind: "store", artifactUrl: "https://x/app.aab" });

  assert.equal(assessHealth([apk, aab]).install?.url, "https://x/app.apk");
});

test("a submission in flight is reported separately from a build", () => {
  const health = assessHealth([release({ kind: "store", status: "running" })]);

  assert.equal(health.submitting, true);
  // Not conflated: "we are building your APK" and "we are pushing this to Play"
  // are different waits with different outcomes.
  assert.equal(health.building, false);
});
