import assert from "node:assert/strict";
import { test } from "node:test";
import type { Release } from "@von/core";
import {
  findRollbackTarget,
  NotRollbackableError,
  rollback,
  ROLLBACK_WORKFLOW,
} from "../src/rollback.ts";
import type { WorkflowDispatcher } from "../src/ship.ts";

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
    createdAt: clock,
    ...overrides,
  };
}

function recorder() {
  const calls: Array<{ repo: string; workflow: string; inputs: Record<string, string> }> = [];
  const dispatcher: WorkflowDispatcher = {
    async dispatch(repo, workflow, _ref, inputs) {
      calls.push({ repo, workflow, inputs });
    },
  };
  return { calls, dispatcher };
}

const target = { appId: "app_1", repoFullName: "von-apps/x", branch: "master" };

test("rolling back restores the previous successful update", async () => {
  const first = release({ instruction: "the good one" });
  const second = release({ instruction: "the bad one" });
  const { calls, dispatcher } = recorder();

  const result = await rollback([first, second], target, dispatcher);

  assert.equal(result.to.id, first.id);
  assert.equal(result.from.id, second.id);
  assert.equal(calls[0]!.workflow, ROLLBACK_WORKFLOW);
  // The update *group* is what identifies a published bundle to EAS.
  assert.equal(calls[0]!.inputs.group, first.externalId);
  assert.equal(calls[0]!.inputs.channel, first.channel);
});

test("order comes from timestamps, not array order", () => {
  const older = release({ id: "rel_old", createdAt: 1 });
  const newer = release({ id: "rel_new", createdAt: 2 });

  const { from, to } = findRollbackTarget([older, newer]);
  assert.equal(from.id, "rel_new");
  assert.equal(to.id, "rel_old");
});

test("a runtime version bump has no OTA path back", () => {
  // An OTA only reaches builds whose runtime version matches. Republishing a
  // bundle from before a native change would reach devices that cannot run it,
  // or silently reach nobody while reporting success.
  const before = release({ runtimeVersion: "1.0.0" });
  const after = release({ runtimeVersion: "1.1.0" });

  assert.throws(
    () => findRollbackTarget([before, after]),
    (err: Error) => {
      assert.ok(err instanceof NotRollbackableError);
      assert.match(err.message, /runtime version 1\.1\.0/);
      return true;
    },
  );
});

test("a native release cannot be undone with an update", () => {
  const ota = release();
  const native = release({ kind: "native", reason: "new dependency" });

  assert.throws(
    () => findRollbackTarget([ota, native]),
    /needs a new build, not an update/,
  );
});

test("failed releases are not rollback targets", () => {
  // Restoring a bundle that never successfully published would leave the
  // channel pointing at nothing.
  const failed = release({ status: "failed" });
  const current = release();

  assert.throws(() => findRollbackTarget([failed, current]), /no earlier successful update/);
});

test("an already rolled-back release is skipped", () => {
  const known_bad = release({ rolledBackBy: "rel_x" });
  const good = release({ id: "rel_good" });
  const current = release();

  // `good` is newer than `known_bad`, so ordering alone would not decide this.
  const { to } = findRollbackTarget([known_bad, good, current]);
  assert.equal(to.id, "rel_good");
});

test("rolling back a rollback is refused", () => {
  const original = release();
  const undo = release({ isRollback: true });

  // Two undos in a row means oscillating between two bundles, which is not a
  // fix — it is a loop with a confused user in it.
  assert.throws(
    () => findRollbackTarget([original, undo]),
    /already a rollback/,
  );
});

test("an app that never published cannot roll back", () => {
  assert.throws(() => findRollbackTarget([]), /never been published/);
});

test("a release with no update group fails before dispatching", async () => {
  const noGroup = release({ externalId: null });
  const current = release();
  const { calls, dispatcher } = recorder();

  // Dispatching anyway would fail obscurely inside the app's own CI, far from
  // the cause.
  await assert.rejects(
    rollback([noGroup, current], target, dispatcher),
    /no update group recorded/,
  );
  assert.equal(calls.length, 0);
});
