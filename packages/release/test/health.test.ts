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
