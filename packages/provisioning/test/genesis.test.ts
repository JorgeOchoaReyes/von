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
  hydrate: {
    branch: "master",
    open: async () => {
      throw new Error("not used in spec-only tests");
    },
  },
  apiUrl: "https://api.von.test",
};

function contextFor(overrides: Partial<GenesisInput> = {}): PlanContext {
  const input: GenesisInput = {
    appId: "app_abcdefghijkl",
    slug: "trail-notes",
    displayName: "Trail Notes",
    description: "log hikes",
    backendTier: "pooled",
    deliveryMode: "standalone",
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

test("a pooled standalone app provisions no GCP project", () => {
  const active = activeSteps(contextFor());

  // The default path. Anything here that touched project creation would put
  // 60-180s of long-running operations in front of a brand-new user.
  assert.deepEqual(active, [
    "gcipTenant",
    "firestore",
    "repo",
    "easProject",
    "easChannel",
    "hydrate",
    "secrets",
  ]);
  for (const dedicatedOnly of ["firebaseProject", "firebaseWebApp", "anonAuth", "deploySa"]) {
    assert.ok(!active.includes(dedicatedOnly), `${dedicatedOnly} must be skipped`);
  }
});

test("shell delivery still skips the per-app EAS project", () => {
  // Not the default any more (docs/ARCHITECTURE.md §12), but still supported —
  // and the thing that distinguishes it is precisely that it has no EAS project.
  const active = activeSteps(contextFor({ deliveryMode: "shell" }));
  assert.deepEqual(active, [
    "gcipTenant",
    "firestore",
    "repo",
    "easChannel",
    "hydrate",
    "secrets",
  ]);
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
  const shell = step.spec(contextFor({ deliveryMode: "shell" }));
  assert.equal(shell.easProjectId, "shell_project_456");
  assert.notEqual(shell.easProjectId, deps.eas.accountId);

  const standaloneCtx = contextFor();
  standaloneCtx.outputs.easProject = { projectId: "own_project_789" };
  assert.equal(step.spec(standaloneCtx).easProjectId, "own_project_789");
});

test("channel names come from the app id, never from user input", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "easChannel")!;

  // For a shell app the channel is the only thing separating its bundle from
  // another tenant's, so a user-controlled name would be a tenancy bug. It
  // stays derived for standalone apps too — the invariant should not depend on
  // which delivery mode happens to be the default.
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

test("hydration substitutes every per-app value the blueprint asks for", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "hydrate")!;

  const ctx = contextFor();
  ctx.outputs.repo = { fullName: "von-apps/trail-notes-ghijkl" };
  ctx.outputs.easProject = { projectId: "eas_proj_1" };

  const spec = step.spec(ctx);
  assert.equal(spec.fullName, "von-apps/trail-notes-ghijkl");
  assert.equal(spec.vars.APP_NAME, "Trail Notes");
  assert.equal(spec.vars.APP_ID, "app_abcdefghijkl");
  assert.equal(spec.vars.EAS_PROJECT_ID, "eas_proj_1");
  assert.equal(spec.vars.VON_API_URL, "https://api.von.test");
  // A pooled app's rules deploy against the pool project; only a dedicated one
  // has a project of its own.
  assert.equal(spec.vars.FIREBASE_PROJECT_ID, "von-pool-001");
});

test("a dedicated app hydrates against its own Firebase project", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "hydrate")!;

  const ctx = contextFor({ backendTier: "dedicated" });
  ctx.outputs.repo = { fullName: "von-apps/x" };
  ctx.outputs.firebaseProject = { projectId: "trail-notes-ghijkl" };

  assert.equal(step.spec(ctx).vars.FIREBASE_PROJECT_ID, "trail-notes-ghijkl");
});

test("the bundle id is derived, never taken from user input", () => {
  const plan = genesisPlan(deps);
  const step = plan.steps.find((s) => s.id === "hydrate")!;

  const ctx = contextFor({ slug: "../../evil app!" });
  ctx.outputs.repo = { fullName: "von-apps/x" };

  // A bundle id is immutable once published and ends up in a manifest, a store
  // listing and a deep-link scheme.
  assert.match(step.spec(ctx).vars.BUNDLE_ID, /^app\.von\.[a-z0-9]*$/);
});

test("secrets wait for hydration, so CI never runs against a template", () => {
  const plan = genesisPlan(deps);
  const secrets = plan.steps.find((s) => s.id === "secrets")!;

  // Adding EXPO_TOKEN is what makes the repo's workflows able to publish. If
  // that landed before substitution, a push could trigger a build of a tree
  // still full of {{TOKEN}} placeholders.
  assert.ok(secrets.needs?.includes("hydrate"));
});
