import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseIdFor } from "../src/drivers/google.ts";
import { genesisPlan, type GenesisDeps, type GenesisInput } from "../src/plans/genesis.ts";
import type { PlanContext } from "../src/orchestrator.ts";

const deps: GenesisDeps = {
  google: {
    auth: { accessToken: async () => "tok" },
    parent: "folders/1",
    billingAccount: "billingAccounts/X",
    poolWebConfig: (poolProjectId: string) => ({ apiKey: "k", projectId: poolProjectId }),
    locationId: "us-central1",
  },
  github: { token: async () => "tok", org: "von-apps", templateRepo: "von/blueprint" },
  eas: {
    token: async () => "tok",
    accountId: "acct_123",
    accountName: "von",
    shellProjectId: "shell_project_456",
  },
};

function contextFor(overrides: Partial<GenesisInput> = {}): PlanContext {
  const input: GenesisInput = {
    appId: "app_abcdefghijkl",
    slug: "trail-notes",
    displayName: "Trail Notes",
    description: "log hikes",
    backendTier: "pooled",
    deliveryMode: "shell",
    poolProjectId: "von-pool-001",
    geminiApiKey: "g",
    expoToken: "e",
    ...overrides,
  };
  return { appId: input.appId, outputs: {}, input };
}

/** Which steps would actually execute, per each step's `when` guard. */
function activeSteps(ctx: PlanContext): string[] {
  return genesisPlan(deps)
    .steps.filter((s) => !s.when || s.when(ctx))
    .map((s) => s.id);
}

test("a pooled shell app provisions no GCP project", () => {
  const active = activeSteps(contextFor());

  // The default path. Anything here that touched project creation would put
  // 60-180s of long-running operations in front of a brand-new user.
  assert.deepEqual(active, ["gcipTenant", "firestore", "repo", "easChannel", "secrets"]);
  for (const dedicatedOnly of ["firebaseProject", "firebaseWebApp", "anonAuth", "deploySa"]) {
    assert.ok(!active.includes(dedicatedOnly), `${dedicatedOnly} must be skipped`);
  }
});

test("a dedicated app provisions its own project and skips the pooled tenant", () => {
  const active = activeSteps(contextFor({ backendTier: "dedicated", deliveryMode: "standalone" }));

  assert.ok(active.includes("firebaseProject"));
  assert.ok(active.includes("firebaseWebApp"));
  assert.ok(active.includes("deploySa"));
  assert.ok(active.includes("easProject"));
  assert.ok(!active.includes("gcipTenant"), "dedicated apps have their own user pool");
});

test("both tiers get a Firestore database, in different projects", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "firestore")!;

  const pooled = step.spec(contextFor());
  assert.equal(pooled.projectId, "von-pool-001");
  assert.equal(pooled.databaseId, databaseIdFor("app_abcdefghijkl"));
  assert.notEqual(pooled.databaseId, "(default)", "pooled apps must not share a database");

  const dedicatedCtx = contextFor({ backendTier: "dedicated" });
  dedicatedCtx.outputs.firebaseProject = { projectId: "trail-notes-ghijkl" };
  const dedicated = step.spec(dedicatedCtx);
  assert.equal(dedicated.projectId, "trail-notes-ghijkl");
  assert.equal(dedicated.databaseId, "(default)");
});

test("a shell app's update channel targets the shell project, not the account", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "easChannel")!;

  // Regression: this previously fell back to `accountId`, which is not a
  // project id — the default delivery path would have failed at channel
  // creation or created the channel against the wrong resource.
  const shell = step.spec(contextFor());
  assert.equal(shell.easProjectId, "shell_project_456");
  assert.notEqual(shell.easProjectId, deps.eas.accountId);

  const standaloneCtx = contextFor({ deliveryMode: "standalone" });
  standaloneCtx.outputs.easProject = { projectId: "own_project_789" };
  assert.equal(step.spec(standaloneCtx).easProjectId, "own_project_789");
});

test("channel names come from the app id, never from user input", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "easChannel")!;

  // For a shell app the channel is the only thing separating its bundle from
  // another tenant's, so a user-controlled name would be a tenancy bug.
  const evil = step.spec(contextFor({ displayName: "../../other", slug: "../../other" }));
  assert.match(evil.channelName, /^app-[a-z0-9]+$/);
});

test("only dedicated apps receive a Firebase deploy credential", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "secrets")!;

  const pooledCtx = contextFor();
  pooledCtx.outputs.repo = { fullName: "von-apps/trail-notes-ghijkl" };
  const pooled = step.spec(pooledCtx);
  assert.ok(!("FIREBASE_SERVICE_ACCOUNT" in pooled.secrets));

  const dedicatedCtx = contextFor({ backendTier: "dedicated" });
  dedicatedCtx.outputs.repo = { fullName: "von-apps/trail-notes-ghijkl" };
  dedicatedCtx.outputs.deploySa = { privateKeyJson: '{"type":"service_account"}' };
  assert.ok("FIREBASE_SERVICE_ACCOUNT" in step.spec(dedicatedCtx).secrets);
});
