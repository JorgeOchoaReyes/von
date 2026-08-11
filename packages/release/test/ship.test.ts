import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_WORKFLOW, OTA_WORKFLOW, shipChange, type WorkflowDispatcher } from "../src/ship.ts";

function recorder() {
  const calls: Array<{ repo: string; workflow: string; ref: string; inputs: Record<string, string> }> = [];
  const dispatcher: WorkflowDispatcher = {
    async dispatch(repo, workflow, ref, inputs) {
      calls.push({ repo, workflow, ref, inputs });
    },
  };
  return { dispatcher, calls };
}

const target = {
  releaseId: "rel_1",
  appId: "app_1",
  repoFullName: "von-apps/trail-notes",
  channel: "app-abc123",
  runtimeVersion: "1.2.0",
  branch: "master",
};

test("a JS change dispatches an OTA update on the app's own channel", async () => {
  const { dispatcher, calls } = recorder();
  const res = await shipChange({ files: ["apps/expo/app/index.tsx"] }, target, dispatcher);

  assert.equal(res.dispatched, OTA_WORKFLOW);
  assert.equal(calls[0]!.workflow, OTA_WORKFLOW);
  // Publishing to the wrong channel succeeds loudly and arrives nowhere, so the
  // channel is always passed explicitly rather than left to a workflow default.
  assert.equal(calls[0]!.inputs.branch, "app-abc123");
  assert.equal(res.runtimeVersion, "1.2.0", "OTA must not move the runtime");
});

test("a native change dispatches a build and bumps the runtime", async () => {
  const { dispatcher, calls } = recorder();
  const res = await shipChange(
    { files: ["apps/expo/app/index.tsx"], addedDependencies: ["expo-camera"] },
    target,
    dispatcher,
  );

  assert.equal(res.dispatched, NATIVE_WORKFLOW);
  assert.equal(calls[0]!.workflow, NATIVE_WORKFLOW);
  assert.equal(res.runtimeVersion, "1.3.0");
});

test("a backend-only change dispatches nothing to the device", async () => {
  const { dispatcher, calls } = recorder();
  const res = await shipChange({ files: ["functions/src/index.ts"] }, target, dispatcher);

  assert.equal(res.dispatched, null);
  assert.equal(calls.length, 0);
  assert.match(res.skipped!, /Backend-only/);
});

test("an empty change dispatches nothing", async () => {
  const { dispatcher, calls } = recorder();
  const res = await shipChange({ files: [] }, target, dispatcher);
  assert.equal(res.dispatched, null);
  assert.equal(calls.length, 0);
});

test("the first change builds, even though it is only JavaScript", async () => {
  const { dispatcher, calls } = recorder();

  // The bug this closes: every app's first instruction is a JS edit, which
  // classifies as OTA. The user was told "it reaches your app in about a
  // minute" for an app that had never been built and existed on no phone.
  const res = await shipChange(
    { files: ["apps/expo/app/index.tsx"] },
    { ...target, builtRuntimeVersions: [] },
    dispatcher,
  );

  assert.equal(res.dispatched, NATIVE_WORKFLOW);
  assert.equal(calls[0]!.workflow, NATIVE_WORKFLOW);
  assert.match(res.decision.reason, /First build/);
});

test("once a build exists at this runtime, JS changes go over the air again", async () => {
  const { dispatcher } = recorder();

  const res = await shipChange(
    { files: ["apps/expo/app/index.tsx"] },
    { ...target, builtRuntimeVersions: ["1.2.0"] },
    dispatcher,
  );

  assert.equal(res.dispatched, OTA_WORKFLOW);
});

test("a build at a different runtime version does not count", async () => {
  const { dispatcher } = recorder();

  // A native release bumped the runtime to 1.2.0 and then failed. The binary
  // that exists is 1.1.0, and an OTA on 1.2.0 reaches nothing.
  const res = await shipChange(
    { files: ["apps/expo/app/index.tsx"] },
    { ...target, builtRuntimeVersions: ["1.1.0"] },
    dispatcher,
  );

  assert.equal(res.dispatched, NATIVE_WORKFLOW);
  assert.match(res.decision.reason, /1\.2\.0/);
});

test("escalating to a build does not bump the runtime version again", async () => {
  const { dispatcher } = recorder();

  // Bumping here would move the target to 1.3.0, build that, and leave the next
  // OTA facing exactly the same "nothing built at this runtime" state — a loop
  // in which no over-the-air update ever ships.
  const res = await shipChange(
    { files: ["apps/expo/app/index.tsx"] },
    { ...target, builtRuntimeVersions: [] },
    dispatcher,
  );

  assert.equal(res.runtimeVersion, "1.2.0");
});

test("a backend-only change is not escalated into a build", async () => {
  const { dispatcher } = recorder();

  // Firestore rules do not live in the binary. Forcing ten minutes of build for
  // one would be the same lie pointed the other way.
  const res = await shipChange(
    { files: ["functions/src/index.ts"] },
    { ...target, builtRuntimeVersions: [] },
    dispatcher,
  );

  assert.equal(res.dispatched, null);
});

test("a caller that says nothing about builds keeps the old behaviour", async () => {
  const { dispatcher } = recorder();

  const res = await shipChange({ files: ["apps/expo/app/index.tsx"] }, target, dispatcher);

  assert.equal(res.dispatched, OTA_WORKFLOW);
});
