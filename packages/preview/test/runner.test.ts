import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { ExpoWebRunner, freePort } from "../src/runner.ts";

/** A stand-in for Metro: never spawns anything, but behaves like a child. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    this.exitCode = 0;
    // Async, like a real process: code that assumes exit is synchronous with
    // kill() deadlocks against a real Metro.
    setImmediate(() => this.emit("exit", 0, signal));
    return true;
  }

  die(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;

test("the runner waits for the server to answer before handing back a URL", async () => {
  const child = new FakeChild();
  let probes = 0;

  const runner = new ExpoWebRunner({
    spawnServer: () => asChild(child),
    // A webview pointed at a not-yet-listening Metro shows a connection error
    // and does not retry, so readiness has to be established here.
    probe: async () => ++probes >= 3,
    urlFor: (port, appId) => `https://preview.von.app/${appId}/${port}`,
  });

  const running = await runner.start("/tmp/repo", { appId: "app_1" });

  assert.equal(probes, 3);
  assert.match(running.url, /^https:\/\/preview\.von\.app\/app_1\/\d+$/);
});

test("the preview serves the Expo app inside the checkout, not the repo root", async () => {
  let dir = "";
  const runner = new ExpoWebRunner({
    spawnServer: (d) => {
      dir = d;
      return asChild(new FakeChild());
    },
    probe: async () => true,
  });

  await runner.start("/tmp/repo", { appId: "app_1" });
  assert.equal(dir, "/tmp/repo/apps/expo");
});

test("a server that dies at boot fails fast instead of timing out", async () => {
  const child = new FakeChild();
  const runner = new ExpoWebRunner({
    spawnServer: () => {
      // A broken app (bad package.json, missing dep) exits immediately. Waiting
      // out the full readiness timeout would make every such failure look like
      // a two-minute hang.
      setImmediate(() => child.die(1));
      return asChild(child);
    },
    probe: async () => false,
    readyTimeoutMs: 60_000,
  });

  await assert.rejects(
    runner.start("/tmp/repo", { appId: "app_1" }),
    /exited early \(code 1/,
  );
});

test("a timeout kills the child rather than leaking it", async () => {
  const child = new FakeChild();
  const runner = new ExpoWebRunner({
    spawnServer: () => asChild(child),
    probe: async () => false,
    readyTimeoutMs: 10,
  });

  await assert.rejects(runner.start("/tmp/repo", { appId: "app_1" }), /not ready in time/);
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("stop terminates the server, and stopping an exited one is a no-op", async () => {
  const child = new FakeChild();
  const runner = new ExpoWebRunner({
    spawnServer: () => asChild(child),
    probe: async () => true,
  });

  const running = await runner.start("/tmp/repo", { appId: "app_1" });
  await running.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);

  await running.stop();
  assert.deepEqual(child.killed, ["SIGTERM"], "already dead: nothing to signal");
});

test("freePort returns a port nothing is holding", async () => {
  const a = await freePort();
  assert.ok(a > 0 && a < 65536);
});
