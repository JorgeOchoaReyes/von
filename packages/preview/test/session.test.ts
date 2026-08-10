import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewSessions, type PreviewWorkspace } from "../src/session.ts";
import type { PreviewRunner, RunningPreview } from "../src/runner.ts";

class FakeWorkspace implements PreviewWorkspace {
  readonly path: string;
  disposed = 0;
  constructor(appId: string) {
    this.path = `/tmp/${appId}`;
  }
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

function harness(opts: { now?: () => number; idleMs?: number; maxSessions?: number } = {}) {
  const opened: string[] = [];
  const workspaces = new Map<string, FakeWorkspace>();
  let started = 0;
  let stopped = 0;
  const stopOrder: string[] = [];

  const runner: PreviewRunner = {
    async start(dir, { appId }): Promise<RunningPreview> {
      started++;
      return {
        url: `http://preview.test/${appId}?dir=${encodeURIComponent(dir)}`,
        port: 4000 + started,
        async stop() {
          stopped++;
          stopOrder.push(appId);
        },
      };
    },
  };

  const sessions = new PreviewSessions<FakeWorkspace>({
    runner,
    open: async (appId) => {
      opened.push(appId);
      const ws = new FakeWorkspace(appId);
      workspaces.set(appId, ws);
      return ws;
    },
    ...opts,
  });

  return { sessions, opened, workspaces, stopOrder, counts: () => ({ started, stopped }) };
}

test("a session is opened once and reused across turns", async () => {
  const h = harness();

  const first = await h.sessions.acquire("app_1");
  const second = await h.sessions.acquire("app_1");

  assert.equal(first, second);
  assert.deepEqual(h.opened, ["app_1"]);
});

test("concurrent turns for one app share a single checkout", async () => {
  // Two clones would mean two working trees, and whichever pushed second would
  // silently discard the other turn's edits.
  const h = harness();

  const [a, b, c] = await Promise.all([
    h.sessions.acquire("app_1"),
    h.sessions.acquire("app_1"),
    h.sessions.acquire("app_1"),
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.deepEqual(h.opened, ["app_1"]);
});

test("a failed open does not poison the app — the next attempt retries", async () => {
  let attempt = 0;
  const sessions = new PreviewSessions<FakeWorkspace>({
    runner: { async start() { throw new Error("unused"); } },
    open: async (appId) => {
      attempt++;
      if (attempt === 1) throw new Error("clone failed");
      return new FakeWorkspace(appId);
    },
  });

  await assert.rejects(sessions.acquire("app_1"), /clone failed/);
  const session = await sessions.acquire("app_1");
  assert.equal(session.appId, "app_1");
});

test("ensureRunning starts exactly one server, however many turns ask", async () => {
  const h = harness();

  const urls = await Promise.all([
    h.sessions.ensureRunning("app_1"),
    h.sessions.ensureRunning("app_1"),
  ]);
  const later = await h.sessions.ensureRunning("app_1");

  assert.equal(h.counts().started, 1, "a second Metro would cost a minute for the same tree");
  assert.equal(urls[0], urls[1]);
  assert.equal(later, urls[0]);
});

test("the preview serves the session's own checkout", async () => {
  const h = harness();
  const url = await h.sessions.ensureRunning("app_1");
  assert.match(url, /%2Ftmp%2Fapp_1/);
});

test("a start failure leaves the session startable again", async () => {
  let calls = 0;
  const sessions = new PreviewSessions<FakeWorkspace>({
    open: async (appId) => new FakeWorkspace(appId),
    runner: {
      async start(_dir, { appId }) {
        calls++;
        if (calls === 1) throw new Error("metro died");
        return { url: `http://preview.test/${appId}`, port: 4001, async stop() {} };
      },
    },
  });

  await assert.rejects(sessions.ensureRunning("app_1"), /metro died/);
  assert.equal(await sessions.ensureRunning("app_1"), "http://preview.test/app_1");
});

test("close stops the server before deleting the checkout", async () => {
  const h = harness();
  await h.sessions.ensureRunning("app_1");
  const ws = h.workspaces.get("app_1")!;

  await h.sessions.close("app_1");

  assert.equal(h.counts().stopped, 1);
  assert.equal(ws.disposed, 1);
  assert.equal(h.sessions.get("app_1"), null);
});

test("closing twice disposes once", async () => {
  const h = harness();
  await h.sessions.acquire("app_1");
  await h.sessions.close("app_1");
  await h.sessions.close("app_1");
  assert.equal(h.workspaces.get("app_1")!.disposed, 1);
});

test("idle sessions are swept — a checkout plus a Metro is not free", async () => {
  let clock = 1_000;
  const h = harness({ now: () => clock, idleMs: 60_000 });

  await h.sessions.ensureRunning("stale");
  clock += 30_000;
  await h.sessions.acquire("fresh");
  clock += 40_000; // stale is 70s idle, fresh is 40s

  assert.deepEqual(await h.sessions.sweep(), ["stale"]);
  assert.equal(h.sessions.get("fresh")?.appId, "fresh");
  assert.equal(h.counts().stopped, 1);
});

test("using a session keeps it alive", async () => {
  let clock = 0;
  const h = harness({ now: () => clock, idleMs: 100 });

  await h.sessions.acquire("app_1");
  clock += 90;
  await h.sessions.acquire("app_1");
  clock += 90;

  assert.deepEqual(await h.sessions.sweep(), []);
});

test("the session cap evicts the least recently used", async () => {
  let clock = 0;
  const h = harness({ now: () => clock, maxSessions: 2 });

  await h.sessions.acquire("a");
  clock += 10;
  await h.sessions.acquire("b");
  clock += 10;
  await h.sessions.acquire("a"); // touch a, so b is now the oldest
  clock += 10;
  await h.sessions.acquire("c");

  assert.equal(h.sessions.size, 2);
  assert.equal(h.sessions.get("b"), null);
  assert.ok(h.sessions.get("a"));
  assert.ok(h.sessions.get("c"));
});

test("pending changes ride on the session, from preview to publish", async () => {
  const h = harness();
  await h.sessions.acquire("app_1");

  h.sessions.setPending("app_1", {
    files: ["apps/expo/app/index.tsx"],
    addedDependencies: [],
    removedDependencies: [],
  });
  assert.deepEqual(h.sessions.get("app_1")!.pending!.files, ["apps/expo/app/index.tsx"]);

  h.sessions.setPending("app_1", null);
  assert.equal(h.sessions.get("app_1")!.pending, null);
});

test("closeAll tears down everything", async () => {
  const h = harness();
  await h.sessions.ensureRunning("a");
  await h.sessions.ensureRunning("b");

  await h.sessions.closeAll();

  assert.equal(h.sessions.size, 0);
  assert.equal(h.counts().stopped, 2);
});

test("each session gets its own token, and the token addresses it", () => {
  // Sequential tokens only in the test; production uses 128 bits of randomness.
  let n = 0;
  const sessions = new PreviewSessions<FakeWorkspace>({
    open: async (appId) => new FakeWorkspace(appId),
    runner: { async start(_d, { appId }) { return { url: `http://x/${appId}`, port: 1, async stop() {} }; } },
    newToken: () => `token${++n}`,
  });

  return (async () => {
    const a = await sessions.acquire("app_a");
    const b = await sessions.acquire("app_b");

    assert.notEqual(a.token, b.token);
    assert.equal(sessions.getByToken(a.token)?.appId, "app_a");
    assert.equal(sessions.getByToken(b.token)?.appId, "app_b");
    assert.equal(sessions.getByToken("token-that-was-never-issued"), null);
  })();
});

test("a closed session's token stops resolving", async () => {
  const h = harness();
  const session = await h.sessions.acquire("app_1");
  const token = session.token;

  await h.sessions.close("app_1");

  // Otherwise a stale preview URL would keep resolving and land on whatever
  // now occupies that port.
  assert.equal(h.sessions.getByToken(token), null);
});

test("the port stays internal until the server is running", async () => {
  const h = harness();
  const session = await h.sessions.acquire("app_1");
  assert.equal(session.port, null);

  await h.sessions.ensureRunning("app_1");
  assert.ok(session.port && session.port > 0);
});

test("publicUrl replaces the loopback URL the runner reports", async () => {
  const sessions = new PreviewSessions<FakeWorkspace>({
    open: async (appId) => new FakeWorkspace(appId),
    runner: { async start() { return { url: "http://127.0.0.1:4000", port: 4000, async stop() {} }; } },
    newToken: () => "tok",
    publicUrl: ({ token }) => `https://${token}.preview.von.app/`,
  });

  // A device cannot reach loopback; the URL the client is handed has to be the
  // proxied one, and the port must not appear in it.
  assert.equal(await sessions.ensureRunning("app_1"), "https://tok.preview.von.app/");
});

test("touching a session by token keeps it from being swept", async () => {
  let clock = 0;
  const h = harness({ now: () => clock, idleMs: 100 });
  const session = await h.sessions.acquire("app_1");

  clock += 90;
  h.sessions.getByToken(session.token); // a preview request arrives
  clock += 90;

  // The user is watching the preview without sending chat turns. Sweeping it
  // would kill the app out from under them mid-look.
  assert.deepEqual(await h.sessions.sweep(), []);
});
