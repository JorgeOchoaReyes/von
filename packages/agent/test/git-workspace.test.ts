import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { GitWorkspace } from "../src/git-workspace.ts";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups) await c().catch(() => {});
});

/** A local bare repo standing in for the app's GitHub repository. */
async function makeRemote(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "von-remote-"));
  const work = join(base, "work");
  const bare = join(base, "bare.git");

  await run("git", ["init", "--bare", "--initial-branch=master", bare]);
  await run("git", ["init", "--initial-branch=master", work]);
  await run("git", ["-C", work, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", work, "config", "user.name", "t"]);

  await writeFile(join(work, "README.md"), "# app\n");
  await run("git", ["-C", work, "add", "-A"]);
  await run("git", ["-C", work, "commit", "-m", "init"]);
  await run("git", ["-C", work, "remote", "add", "origin", bare]);
  await run("git", ["-C", work, "push", "origin", "master"]);

  return bare;
}

function open(remote: string): GitWorkspace {
  const ws = new GitWorkspace({
    fullName: "von-apps/test",
    token: async () => "unused-for-local-remote",
    branch: "master",
    remoteUrl: remote,
  });
  cleanups.push(() => ws.dispose());
  return ws;
}

test("edits are committed and pushed to the remote", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await ws.write("apps/expo/app/index.tsx", "export default function A() {}\n");
  const changed = await ws.gitChangedFiles();
  assert.deepEqual(changed, ["apps/expo/app/index.tsx"]);

  const sha = await ws.commitAndPush("add a screen");
  assert.ok(sha, "expected a commit sha");

  // Read it back from the remote to prove the push actually landed.
  const out = await run("git", ["-C", remote, "show", "--name-only", "--format=", "HEAD"]);
  assert.match(out.stdout, /apps\/expo\/app\/index\.tsx/);
});

test("a no-op edit produces no commit and therefore no release", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  // The agent rewrote a file with identical content — common, and it must not
  // create an empty commit that dispatches a pointless build.
  const existing = await ws.read("README.md");
  await ws.write("README.md", existing!);

  assert.equal(await ws.commitAndPush("no-op"), null);
});

test("reads and lists come from the real checkout", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  assert.match((await ws.read("README.md"))!, /# app/);
  assert.equal(await ws.read("does/not/exist.ts"), null);
  assert.deepEqual(await ws.list(), ["README.md"]);
});

test("paths cannot escape the repository", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  // These paths come from a model, so traversal is a reachable input, not a
  // hypothetical one.
  for (const evil of ["../escape.txt", "../../etc/passwd", "a/../../escape.txt"]) {
    await assert.rejects(ws.write(evil, "x"), /escapes the repository/, evil);
  }
  await assert.rejects(ws.read("../../etc/passwd"), /escapes the repository/);
});

test("git internals are off limits", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await assert.rejects(ws.write(".git/config", "x"), /git internals/);
  await assert.rejects(ws.write(".git/hooks/pre-commit", "x"), /git internals/);
});

test("nested directories are created on write", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await ws.write("a/b/c/deep.ts", "export const x = 1;\n");
  assert.equal(await ws.read("a/b/c/deep.ts"), "export const x = 1;\n");
});

test("the checkout is removed on dispose", async () => {
  const remote = await makeRemote();
  const ws = new GitWorkspace({
    fullName: "von-apps/test",
    token: async () => "unused",
    branch: "master",
    remoteUrl: remote,
  });
  await ws.open();
  await ws.write("x.ts", "1");
  await ws.dispose();

  // A long-lived process holding clones of customers' repos on disk is a leak.
  await assert.rejects(ws.read("x.ts"), /not opened/);
});

test("a new directory is reported file-by-file, not collapsed", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  // Regression: plain `git status --porcelain` reports this as `apps/`, which
  // the release classifier treats as an unrecognised path and routes to a
  // native build — a ten-minute rebuild every time the agent adds a screen.
  await ws.write("apps/expo/app/index.tsx", "export default function A() {}\n");
  await ws.write("apps/expo/app/detail.tsx", "export default function B() {}\n");

  assert.deepEqual(await ws.gitChangedFiles(), [
    "apps/expo/app/detail.tsx",
    "apps/expo/app/index.tsx",
  ]);
});

test("a rejected preview is discarded, modifications and additions alike", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await ws.write("README.md", "# rewritten by the agent\n");
  await ws.write("apps/expo/app/new.tsx", "export default function A() {}\n");
  assert.equal((await ws.gitChangedFiles()).length, 2);

  await ws.discardChanges();

  // Both halves matter: `reset` alone leaves the new file behind, `clean` alone
  // leaves the rewritten one. Either way the next turn starts from a tree the
  // user already rejected.
  assert.deepEqual(await ws.gitChangedFiles(), []);
  assert.equal(await ws.read("README.md"), "# app\n");
  assert.equal(await ws.read("apps/expo/app/new.tsx"), null);
});

test("discarding leaves published work alone", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await ws.write("apps/expo/app/kept.tsx", "export const kept = 1;\n");
  await ws.commitAndPush("published");
  await ws.write("apps/expo/app/rejected.tsx", "export const no = 1;\n");

  await ws.discardChanges();

  assert.equal(await ws.read("apps/expo/app/kept.tsx"), "export const kept = 1;\n");
  assert.equal(await ws.read("apps/expo/app/rejected.tsx"), null);
});

test("the token is fetched per operation, not captured at clone time", async () => {
  const remote = await makeRemote();
  let calls = 0;
  const ws = new GitWorkspace({
    fullName: "von-apps/test",
    token: async () => `token-${++calls}`,
    branch: "master",
    remoteUrl: remote,
  });
  cleanups.push(() => ws.dispose());
  await ws.open();

  // A preview session outlives a GitHub installation token's hour, and the
  // expiry would surface at the push — the one operation the user is watching.
  const atClone = calls;
  await ws.write("apps/expo/app/index.tsx", "export default function A() {}\n");
  await ws.commitAndPush("later");
  assert.ok(calls > atClone, "expected a fresh token for operations after the clone");
});

test("two live workspaces do not clobber each other's credentials", async () => {
  const [remoteA, remoteB] = await Promise.all([makeRemote(), makeRemote()]);
  const a = open(remoteA);
  const b = open(remoteB);
  await a.open();
  await b.open();

  // Preview keeps a checkout open per app, so several are alive at once. When
  // the token lived in process.env, disposing one broke the others' pushes.
  await b.dispose();

  await a.write("apps/expo/app/index.tsx", "export default function A() {}\n");
  assert.ok(await a.commitAndPush("still works"));
});

test("renames report the new path", async () => {
  const remote = await makeRemote();
  const ws = open(remote);
  await ws.open();

  await ws.write("apps/expo/app/old.tsx", "export const x = 1;\n");
  await ws.commitAndPush("add");
  await ws.write("apps/expo/app/new.tsx", "export const x = 1;\n");
  await ws.remove("apps/expo/app/old.tsx");

  const changed = await ws.gitChangedFiles();
  assert.ok(changed.includes("apps/expo/app/new.tsx"), changed.join(","));
});
