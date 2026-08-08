import assert from "node:assert/strict";
import { test } from "node:test";
import { rollout } from "../src/fleet.ts";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ appId: `app_${i}` }));

test("one app's failure does not stop the rollout", async () => {
  const summary = await rollout(items(5), async (item) => {
    if (item.appId === "app_2") throw new Error("boom");
    return item.appId;
  });

  assert.equal(summary.ok, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.aborted, false);
  assert.match(summary.outcomes.find((o) => o.appId === "app_2")!.error!, /boom/);
});

test("concurrency is bounded so providers do not rate-limit the fleet", async () => {
  let inFlight = 0;
  let peak = 0;

  await rollout(
    items(20),
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
    { concurrency: 4 },
  );

  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test("a systemic failure aborts instead of churning through every app", async () => {
  let attempts = 0;
  const summary = await rollout(
    items(100),
    async () => {
      attempts++;
      throw new Error("expired token");
    },
    { concurrency: 2, abortAfterFailures: 3 },
  );

  assert.equal(summary.aborted, true);
  assert.ok(attempts < 100, `should stop early, attempted ${attempts}`);
});

test("filtered apps are skipped, not counted as failures", async () => {
  const summary = await rollout(items(4), async (i) => i.appId, {
    filter: (i) => i.appId !== "app_1",
  });

  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.ok, 3);
});

test("progress is reported for every app", async () => {
  const seen: number[] = [];
  await rollout(items(6), async () => undefined, {
    concurrency: 3,
    onProgress: (done, total) => {
      seen.push(done);
      assert.equal(total, 6);
    },
  });
  assert.equal(seen.length, 6);
});
