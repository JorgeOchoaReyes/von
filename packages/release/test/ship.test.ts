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
