import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryLedger, type ResourceKind } from "@von/core";
import { RetryableError, TerminalError, type Driver } from "../src/driver.ts";
import { runPlan, type PlanContext, type Step } from "../src/orchestrator.ts";

/** A driver that records calls, so tests can assert on create-vs-read behaviour. */
function fakeDriver(
  kind: ResourceKind,
  opts: {
    failTimes?: number;
    terminal?: boolean;
    existing?: Record<string, unknown> | null;
  } = {},
) {
  const calls = { create: 0, read: 0 };
  let remainingFailures = opts.failTimes ?? 0;

  const driver: Driver<{ appId: string }, Record<string, unknown>> = {
    kind,
    key: (s) => `${kind}:${s.appId}`,
    async read() {
      calls.read++;
      return opts.existing ?? null;
    },
    async create() {
      calls.create++;
      if (remainingFailures > 0) {
        remainingFailures--;
        throw opts.terminal
          ? new TerminalError("nope")
          : new RetryableError("try again");
      }
      return { externalId: `${kind}-id` };
    },
  };
  return { driver, calls };
}

const ctx = (): PlanContext => ({ appId: "app_test", outputs: {}, input: {} });
const noSleep = async () => {};

test("a completed plan records every step in the ledger", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("github.repo");
  const b = fakeDriver("eas.channel");

  const steps: Step[] = [
    { id: "repo", driver: a.driver, spec: () => ({ appId: "app_test" }) },
    {
      id: "channel",
      driver: b.driver,
      needs: ["repo"],
      spec: () => ({ appId: "app_test" }),
    },
  ];

  await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });

  const records = await ledger.listByApp("app_test");
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.state === "ready"));
});

test("re-running a plan does not create anything twice", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("github.repo");
  const steps: Step[] = [
    { id: "repo", driver: a.driver, spec: () => ({ appId: "app_test" }) },
  ];

  await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });
  await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });

  // This is the whole point of the ledger: a retried genesis resumes rather
  // than provisioning a second GCP project we would be billed for.
  assert.equal(a.calls.create, 1);
});

test("resuming after a crash mid-create adopts the orphaned resource", async () => {
  const ledger = new InMemoryLedger();
  // Simulate: we wrote `creating` to the ledger, the provider succeeded, we died
  // before recording it.
  await ledger.upsert({
    key: "github.repo:app_test",
    kind: "github.repo",
    appId: "app_test",
    state: "creating",
    externalId: null,
    outputs: {},
    error: null,
    attempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const a = fakeDriver("github.repo", { existing: { externalId: "already-there" } });
  const steps: Step[] = [
    { id: "repo", driver: a.driver, spec: () => ({ appId: "app_test" }) },
  ];

  const out = await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });

  assert.equal(a.calls.read, 1);
  assert.equal(a.calls.create, 0, "must adopt, not duplicate");
  assert.equal(out.outputs.repo!.externalId, "already-there");
});

test("retryable failures back off and then succeed", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("gcip.tenant", { failTimes: 2 });
  const steps: Step[] = [
    { id: "tenant", driver: a.driver, spec: () => ({ appId: "app_test" }) },
  ];

  await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });
  assert.equal(a.calls.create, 3);
});

test("terminal failures abort immediately instead of hammering the provider", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("gcip.tenant", { failTimes: 99, terminal: true });
  const steps: Step[] = [
    { id: "tenant", driver: a.driver, spec: () => ({ appId: "app_test" }) },
  ];

  await assert.rejects(
    runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep }),
    /nope/,
  );
  assert.equal(a.calls.create, 1);

  const record = await ledger.get("gcip.tenant:app_test");
  assert.equal(record?.state, "failed");
});

test("skipped steps do not block the steps that depend on them", async () => {
  const ledger = new InMemoryLedger();
  const skipped = fakeDriver("eas.project");
  const dependent = fakeDriver("eas.channel");

  const steps: Step[] = [
    {
      id: "easProject",
      driver: skipped.driver,
      when: () => false, // shell delivery: no per-app EAS project
      spec: () => ({ appId: "app_test" }),
    },
    {
      id: "easChannel",
      driver: dependent.driver,
      needs: ["easProject"],
      spec: () => ({ appId: "app_test" }),
    },
  ];

  await runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep });

  assert.equal(skipped.calls.create, 0);
  assert.equal(dependent.calls.create, 1, "channel must still be created");
});

test("a dependency cycle is caught before anything is provisioned", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("github.repo");
  const steps: Step[] = [
    { id: "x", driver: a.driver, needs: ["y"], spec: () => ({ appId: "app_test" }) },
    { id: "y", driver: a.driver, needs: ["x"], spec: () => ({ appId: "app_test" }) },
  ];

  await assert.rejects(
    runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep }),
    /Cyclic/,
  );
  assert.equal(a.calls.create, 0);
});

test("a dependency on an unknown step is caught, not silently ignored", async () => {
  const ledger = new InMemoryLedger();
  const a = fakeDriver("github.repo");
  const steps: Step[] = [
    { id: "x", driver: a.driver, needs: ["missing"], spec: () => ({ appId: "app_test" }) },
  ];

  await assert.rejects(
    runPlan({ name: "t", steps }, ctx(), ledger, { sleep: noSleep }),
    /unknown step "missing"/,
  );
});
