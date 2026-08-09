import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { PreviewSessions, type PreviewWorkspace } from "@von/preview";
import { previewProxy } from "../src/proxy.ts";

const HOST = "preview.von.test";
const TOKEN = "b".repeat(32);

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** A stand-in for Metro: echoes back what it was asked, so the proxy's
 * faithfulness is observable rather than assumed. */
async function upstream(): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(req.url === "/missing" ? 404 : 200, {
        "content-type": "application/json",
        "x-upstream": "metro",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

class FakeWorkspace implements PreviewWorkspace {
  readonly path = "/tmp/ws";
  async dispose(): Promise<void> {}
}

/** Sessions wired to a real upstream, with a fixed token. */
async function sessionsWithUpstream(): Promise<{
  sessions: PreviewSessions<FakeWorkspace>;
  port: number;
}> {
  const port = await upstream();
  const sessions = new PreviewSessions<FakeWorkspace>({
    open: async () => new FakeWorkspace(),
    runner: async_runner(port),
    newToken: () => TOKEN,
  });
  await sessions.ensureRunning("app_1");
  return { sessions, port };
}

const async_runner = (port: number) => ({
  async start() {
    return { url: `http://127.0.0.1:${port}`, port, async stop() {} };
  },
});

const get = (path: string, host: string, init: RequestInit = {}) =>
  new Request(`http://ignored${path}`, { ...init, headers: { host, ...(init.headers ?? {}) } });

test("a request to a session's origin reaches its dev server unmodified", async () => {
  const { sessions, port } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  // Metro serves root-absolute paths; the proxy must pass them through exactly,
  // including the query string, or the bundle 404s.
  const res = await proxy(get("/index.bundle?platform=web&dev=true", `${TOKEN}.${HOST}`));
  assert.ok(res);
  assert.equal(res.status, 200);

  const echoed = (await res.json()) as { url: string; host: string; method: string };
  assert.equal(echoed.url, "/index.bundle?platform=web&dev=true");
  assert.equal(echoed.method, "GET");
  // Rewritten to loopback: a forwarded public Host confuses Metro's dev
  // middleware and its CORS checks.
  assert.equal(echoed.host, `127.0.0.1:${port}`);
});

test("upstream status and headers survive the round trip", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  const res = await proxy(get("/missing", `${TOKEN}.${HOST}`));
  assert.equal(res!.status, 404);
  assert.equal(res!.headers.get("x-upstream"), "metro");
});

test("request bodies are forwarded", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  const res = await proxy(
    get("/symbolicate", `${TOKEN}.${HOST}`, { method: "POST", body: "stack-trace" }),
  );

  const echoed = (await res!.json()) as { method: string; body: string };
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.body, "stack-trace");
});

test("control-plane requests fall through untouched", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  // Null means "not a preview request" — the control plane's own routes must
  // never see a preview's path, and vice versa.
  assert.equal(await proxy(get("/v1/apps", "api.von.test")), null);
  assert.equal(await proxy(get("/v1/apps", HOST)), null);
});

test("an unknown token is refused, not forwarded", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  const res = await proxy(get("/", `${"c".repeat(32)}.${HOST}`));
  assert.equal(res!.status, 404);
  // Same answer as an expired session: saying which is which would confirm a
  // token exists.
  assert.match(await res!.text(), /no longer running/);
});

test("a closed session stops being reachable", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, HOST);

  assert.equal((await proxy(get("/", `${TOKEN}.${HOST}`)))!.status, 200);
  await sessions.close("app_1");

  const res = await proxy(get("/", `${TOKEN}.${HOST}`));
  assert.equal(res!.status, 404);
});

test("with no preview host configured nothing is proxied", async () => {
  const { sessions } = await sessionsWithUpstream();
  const proxy = previewProxy(sessions, null);

  // Deployments without wildcard DNS must not accidentally expose previews on
  // the control plane's own origin.
  assert.equal(await proxy(get("/", `${TOKEN}.${HOST}`)), null);
});

test("a dead dev server reports a gateway failure, not a crash", async () => {
  const sessions = new PreviewSessions<FakeWorkspace>({
    open: async () => new FakeWorkspace(),
    // Port 1 is reserved and nothing listens on it.
    runner: async_runner(1),
    newToken: () => TOKEN,
  });
  await sessions.ensureRunning("app_1");

  const res = await previewProxy(sessions, HOST)(get("/", `${TOKEN}.${HOST}`));
  assert.equal(res!.status, 502);
});
