import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_WORKFLOW, OTA_WORKFLOW, ROLLBACK_WORKFLOW, STORE_WORKFLOW } from "@von/release";

/**
 * The control plane names a workflow file; the generated repo has to contain it.
 *
 * These two facts live in different packages and nothing connects them, so they
 * drifted: `shipChange` dispatched `eas-android-apk.yml` for every native
 * change while the blueprint shipped only the OTA and rollback workflows. GitHub
 * answers a dispatch for a file that does not exist with a 404, so publishing
 * anything native — the first release of every app included — failed with an
 * error about a missing workflow, and no app could reach a phone at all.
 */

const WORKFLOWS = fileURLToPath(
  new URL("../../../templates/app-blueprint/.github/workflows", import.meta.url),
);

test("every workflow the platform dispatches exists in the blueprint", async () => {
  const present = new Set(await readdir(WORKFLOWS));

  for (const file of [OTA_WORKFLOW, NATIVE_WORKFLOW, ROLLBACK_WORKFLOW, STORE_WORKFLOW]) {
    assert.ok(present.has(file), `${file} is dispatched but not in the blueprint`);
  }
});

test("a dispatched workflow accepts the inputs the platform sends", async () => {
  // `workflow_dispatch` silently drops inputs a workflow does not declare. The
  // run then succeeds having reported nothing back, and the release sits at
  // `queued` forever with no handle on what it published.
  for (const file of [OTA_WORKFLOW, NATIVE_WORKFLOW, STORE_WORKFLOW]) {
    const yaml = await readFile(`${WORKFLOWS}/${file}`, "utf8");

    assert.match(yaml, /workflow_dispatch:/, `${file} cannot be dispatched`);
    assert.match(yaml, /release_id:/, `${file} would not report its outcome`);
    assert.match(yaml, /app_id:/, `${file} would not know which app to report to`);
    assert.match(
      yaml,
      /releases\/\$RELEASE_ID\/complete/,
      `${file} never calls back, so its release never leaves "queued"`,
    );
  }
});

test("the build workflows are never triggered by a push", async () => {
  // Ten minutes of build per commit, dispatched by nobody, is how a free Expo
  // build quota disappears in an afternoon. Builds are deliberate — and a Play
  // submission triggered by a commit would put code in front of testers that
  // nobody decided to show them.
  for (const file of [NATIVE_WORKFLOW, STORE_WORKFLOW]) {
    const yaml = await readFile(`${WORKFLOWS}/${file}`, "utf8");
    assert.doesNotMatch(yaml, /^\s{2}push:/m, `${file} builds on every push`);
  }
});

test("the Play workflow refuses before spending a build it cannot submit", async () => {
  const yaml = await readFile(`${WORKFLOWS}/${STORE_WORKFLOW}`, "utf8");

  // The credential check has to come before `eas build`, or a missing secret
  // costs ten minutes and reports a failure whose cause is one line of config.
  const guard = yaml.indexOf("GOOGLE_PLAY_SERVICE_ACCOUNT is not set");
  const build = yaml.indexOf("eas build");

  assert.ok(guard > 0, "no credential guard");
  assert.ok(guard < build, "the credential guard runs after the build");
});
