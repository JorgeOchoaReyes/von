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
    install: async () => {},
    spawnServer: () => asChild(child),
    // A webview pointed at a not-yet-listening Metro shows a connection error
    // and does not retry, so readiness has to be established here.
    probe: async () => ++probes >= 3,
  });

  const running = await runner.start("/tmp/repo", { appId: "app_1" });

  assert.equal(probes, 3);
  assert.equal(running.url, `http://127.0.0.1:${running.port}`);
  assert.ok(running.port > 0);
});

test("the preview serves the Expo app inside the checkout, not the repo root", async () => {
  let dir = "";
  const runner = new ExpoWebRunner({
    install: async () => {},
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
    install: async () => {},
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
    install: async () => {},
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
    install: async () => {},
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

test("dependencies are installed before Metro is started", async () => {
  const order: string[] = [];
  const runner = new ExpoWebRunner({
    install: async (dir) => {
      order.push(`install:${dir}`);
    },
    spawnServer: () => {
      order.push("metro");
      return asChild(new FakeChild());
    },
    probe: async () => true,
  });

  await runner.start("/tmp/repo", { appId: "app_1" });

  // A fresh shallow clone has no node_modules; starting Metro first means it
  // exits instantly on a module resolution error and the preview never appears.
  assert.deepEqual(order, ["install:/tmp/repo", "metro"]);
});

test("the install runs at the repo root, not in the Expo app", async () => {
  let installDir = "";
  let metroDir = "";
  const runner = new ExpoWebRunner({
    install: async (dir) => {
      installDir = dir;
    },
    spawnServer: (dir) => {
      metroDir = dir;
      return asChild(new FakeChild());
    },
    probe: async () => true,
  });

  await runner.start("/tmp/repo", { appId: "app_1" });

  // It is a workspace: dependencies are hoisted to the root even though Metro
  // runs inside apps/expo.
  assert.equal(installDir, "/tmp/repo");
  assert.equal(metroDir, "/tmp/repo/apps/expo");
});

test("a failed install surfaces instead of a confusing Metro error", async () => {
  const runner = new ExpoWebRunner({
    install: async () => {
      throw new Error("pnpm install failed with code 1");
    },
    spawnServer: () => asChild(new FakeChild()),
    probe: async () => true,
  });

  await assert.rejects(
    runner.start("/tmp/repo", { appId: "app_1" }),
    /pnpm install failed/,
  );
});
