import type { App } from "@von/core";
import { GitWorkspace, runAgent, type AgentEvent } from "@von/agent";
import { diffDependencies } from "@von/agent";
import { newReleaseId, type Release } from "@von/core";
import {
  classifyChange,
  rollback as rollbackRelease,
  shipChange,
  type ReleaseDecision,
  type RollbackResult,
  type ShipResult,
  type WorkflowDispatcher,
} from "@von/release";
import type { PreviewSessions } from "@von/preview";
import { dispatchWorkflow, type GitHubCtx } from "@von/provisioning";
import { PROD_BRANCH } from "@von/generator";
import type { Store } from "./store.ts";

/**
 * The one path that makes and updates apps.
 *
 * Chat, the REST endpoints, and fleet rollouts all funnel through here, so
 * there is a single place where "an instruction becomes a change on someone's
 * phone" is defined — and therefore a single place to fix when it is wrong.
 *
 * It has two halves, and the split is the product:
 *
 *   preview:  agent edits the working tree -> web preview -> classify what
 *             publishing *would* do
 *   publish:  commit & push -> dispatch OTA or native build -> record the
 *             runtime version
 *
 * Nothing leaves the session until the user says so. Before this split, every
 * turn pushed to master and shipped to whatever devices had the app installed,
 * which meant a user exploring an idea was shipping each half-formed step of it
 * to their own users. Preview makes iteration free and publishing deliberate.
 *
 * Note it classifies the diff **git** reports, not the paths the agent claims
 * it touched. An agent that rewrites a file with identical content reports a
 * change; git does not. Trusting the agent there would ship empty releases and,
 * worse, bump runtime versions for no reason — invalidating every installed
 * build's OTA channel.
 */
export type Sessions = PreviewSessions<GitWorkspace>;

export interface PreviewOptions {
  instruction: string;
  /** Streams agent output; omit for headless/fleet use. */
  onEvent?: (e: AgentEvent) => void;
  /** Skip the agent and just look at what is already in the tree. */
  skipAgent?: boolean;
  /**
   * Start (or reuse) the preview server. False for fleet work, where nobody is
   * watching and a Metro per app would be thousands of idle processes.
   */
  startPreview?: boolean;
}

export interface PreviewResult {
  appId: string;
  changedFiles: string[];
  /** What publishing this would do — shown before the user commits to it. */
  decision: ReleaseDecision;
  /** Null when the preview server could not start, or was not requested. */
  previewUrl: string | null;
  /** Set when the preview server failed; the change is still publishable. */
  previewError?: string;
  summary: string;
}

export interface PublishResult {
  appId: string;
  /** Null when there was nothing to publish. */
  commitSha: string | null;
  ship: ShipResult | null;
  summary: string;
}

/** Preview then publish in one call — the headless path, used by fleet updates. */
export type UpdateOptions = Omit<PreviewOptions, "startPreview">;
export type UpdateResult = PublishResult;

export function githubDispatcher(github: GitHubCtx): WorkflowDispatcher {
  return {
    dispatch: (repo, workflow, ref, inputs) =>
      dispatchWorkflow(github, repo, workflow, ref, inputs),
  };
}

function requireRepo(app: App): string {
  if (!app.repoFullName) {
    throw new Error(
      `app ${app.id} has no repository yet — provisioning may still be running`,
    );
  }
  return app.repoFullName;
}

/** Open a checkout for a preview session. Wired into `PreviewSessions.open`. */
export function openWorkspace(app: App, github: GitHubCtx): Promise<GitWorkspace> {
  const workspace = new GitWorkspace({
    fullName: requireRepo(app),
    token: github.token,
    branch: PROD_BRANCH,
  });
  return workspace.open().then(() => workspace);
}

/**
 * Apply an instruction to the app's working tree and show the result.
 *
 * Nothing is committed and nothing ships. The tree stays dirty on the session
 * so `publishChange` can pick it up, and the changed-file list is recorded now
 * because after the commit git has nothing left to report.
 */
export async function previewChange(
  sessions: Sessions,
  app: App,
  opts: PreviewOptions,
): Promise<PreviewResult> {
  requireRepo(app);

  const session = await sessions.acquire(app.id);
  const workspace = session.workspace;

  const pkgBefore = await workspace.read("apps/expo/package.json");

  if (!opts.skipAgent) {
    const summary = `You are editing "${app.name}" (${app.id}).\n${app.description}`;
    for await (const ev of runAgent({
      workspace,
      message: opts.instruction,
      appSummary: summary,
      backendTier: app.backendTier,
    })) {
      opts.onEvent?.(ev);
    }
  }

  const changedFiles = await workspace.gitChangedFiles();
  const pkgAfter = await workspace.read("apps/expo/package.json");
  const deps = diffDependencies(pkgBefore, pkgAfter);

  const pending =
    changedFiles.length === 0
      ? null
      : {
          files: changedFiles,
          addedDependencies: deps.added,
          removedDependencies: deps.removed,
          label: opts.instruction,
        };
  sessions.setPending(app.id, pending);

  const decision = classifyChange(
    pending ?? { files: [], addedDependencies: [], removedDependencies: [] },
  );

  let previewUrl: string | null = null;
  let previewError: string | undefined;
  if (opts.startPreview !== false) {
    try {
      previewUrl = await sessions.ensureRunning(app.id);
    } catch (err) {
      // A preview that will not boot must not block publishing. The user loses
      // the fast look, not the ability to ship — and the reason is surfaced
      // rather than swallowed, because "no preview appeared" with no
      // explanation is worse than a slow one.
      previewError = (err as Error).message;
    }
  }

  return {
    appId: app.id,
    changedFiles,
    decision,
    previewUrl,
    previewError,
    summary: pending ? decision.reason : "No changes were needed.",
  };
}

/**
 * Commit what the user previewed, push it, and dispatch the release.
 *
 * The change set comes from the session rather than being recomputed: by the
 * time this runs the commit is what holds the diff, and asking git again would
 * report an empty tree and classify every publish as a no-op.
 */
export async function publishChange(
  store: Store,
  sessions: Sessions,
  app: App,
  github: GitHubCtx,
): Promise<PublishResult> {
  const repoFullName = requireRepo(app);
  const session = sessions.get(app.id);

  if (!session?.pending) {
    return {
      appId: app.id,
      commitSha: null,
      ship: null,
      summary: "Nothing to publish — the last change was already published, or was a no-op.",
    };
  }

  const pending = session.pending;
  const commitSha = await session.workspace.commitAndPush(
    `${(pending.label ?? "Update").slice(0, 68)}\n\nvia Von`,
  );
  if (!commitSha) {
    sessions.setPending(app.id, null);
    return { appId: app.id, commitSha: null, ship: null, summary: "No changes were needed." };
  }

  const ship = await shipChange(
    pending,
    {
      appId: app.id,
      repoFullName,
      channel: app.channel,
      runtimeVersion: app.runtimeVersion,
      branch: PROD_BRANCH,
    },
    githubDispatcher(github),
  );

  if (ship.runtimeVersion !== app.runtimeVersion) {
    await store.updateApp(app.id, { runtimeVersion: ship.runtimeVersion });
  }

  // Recorded whatever the outcome, including `none`. A release history with the
  // uninteresting entries filtered out is a history you cannot reason about —
  // and "the last thing that shipped" is exactly the question rollback asks.
  await store.recordRelease(releaseRecord(app, pending.label ?? "", commitSha, ship));

  // Cleared only after the dispatch succeeded: a failed dispatch leaves the
  // change pending and republishable rather than committed-but-never-shipped.
  sessions.setPending(app.id, null);

  return { appId: app.id, commitSha, ship, summary: ship.decision.reason };
}

/** The record of what a publish did, in the shape the store keeps. */
function releaseRecord(
  app: App,
  instruction: string,
  commitSha: string,
  ship: ShipResult,
): Release {
  return {
    id: newReleaseId(),
    appId: app.id,
    kind: ship.decision.kind === "native" ? "native" : "ota",
    reason: ship.decision.reason,
    channel: app.channel,
    runtimeVersion: ship.runtimeVersion,
    // The workflow is dispatched, not finished. Its real outcome arrives later;
    // claiming success here would make a failed build look like a shipped one.
    status: ship.dispatched ? "queued" : "succeeded",
    externalId: null,
    artifactUrl: null,
    commitSha,
    instruction,
    rolledBackBy: null,
    isRollback: false,
    createdAt: Date.now(),
  };
}

/**
 * Undo the last release by republishing the one before it.
 *
 * Both records are written: the rollback as a new release, and the bad one
 * marked with what replaced it. Marking rather than deleting keeps the history
 * honest — and stops the next rollback from choosing the bundle that was just
 * rejected.
 */
export async function rollbackApp(
  store: Store,
  app: App,
  github: GitHubCtx,
): Promise<RollbackResult> {
  const repoFullName = requireRepo(app);
  const releases = await store.listReleases(app.id);

  const result = await rollbackRelease(
    releases,
    { appId: app.id, repoFullName, branch: PROD_BRANCH },
    githubDispatcher(github),
  );

  const undo: Release = {
    ...releaseRecord(app, `Roll back to ${result.to.id}`, result.to.commitSha ?? "", {
      appId: app.id,
      decision: {
        kind: "ota",
        reason: `Restored the update from ${result.to.id}`,
        triggers: ["rollback"],
        requiresRuntimeBump: false,
      },
      dispatched: "eas-update.yml",
      runtimeVersion: result.to.runtimeVersion,
    }),
    externalId: result.to.externalId,
    isRollback: true,
  };

  await store.recordRelease(undo);
  await store.updateRelease(result.from.id, { rolledBackBy: undo.id });

  return result;
}

/**
 * Throw away an unpublished preview and go back to what is live.
 *
 * The preview server keeps running: the user is still iterating, they just
 * rejected this attempt.
 */
export async function discardPreview(sessions: Sessions, app: App): Promise<void> {
  const session = sessions.get(app.id);
  if (!session) return;
  await session.workspace.discardChanges();
  sessions.setPending(app.id, null);
}

/**
 * Preview and publish in one call.
 *
 * The non-interactive path: fleet rollouts, scripts and CI, where there is no
 * user to look at a preview. It closes the session afterwards, since holding a
 * checkout and a server open for an app nobody is editing is pure cost.
 */
export async function updateApp(
  store: Store,
  sessions: Sessions,
  app: App,
  github: GitHubCtx,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  try {
    const preview = await previewChange(sessions, app, { ...opts, startPreview: false });
    if (preview.changedFiles.length === 0) {
      return { appId: app.id, commitSha: null, ship: null, summary: preview.summary };
    }
    return await publishChange(store, sessions, app, github);
  } finally {
    await sessions.close(app.id);
  }
}
