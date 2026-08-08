import type { App } from "@von/core";
import { GitWorkspace, runAgent, type AgentEvent } from "@von/agent";
import { diffDependencies } from "@von/agent";
import { shipChange, type ShipResult, type WorkflowDispatcher } from "@von/release";
import { dispatchWorkflow, type GitHubCtx } from "@von/provisioning";
import { PROD_BRANCH } from "@von/generator";
import type { Store } from "./store.ts";

/**
 * The one path that makes and updates apps.
 *
 * Chat, the REST endpoint, and the fleet rollout all funnel through here, so
 * there is a single place where "an instruction becomes a change on someone's
 * phone" is defined — and therefore a single place to fix when it is wrong.
 *
 * The sequence is always the same:
 *
 *   clone -> agent edits -> commit & push -> classify the real git diff ->
 *   dispatch OTA or build -> record the runtime version
 *
 * Note it classifies the diff **git** reports, not the paths the agent claims
 * it touched. An agent that rewrites a file with identical content reports a
 * change; git does not. Trusting the agent there would ship empty releases and,
 * worse, bump runtime versions for no reason — invalidating every installed
 * build's OTA channel.
 */
export interface UpdateOptions {
  instruction: string;
  /** Streams agent output; omit for headless/fleet use. */
  onEvent?: (e: AgentEvent) => void;
  /** Skip the agent and just ship what is already on the branch. */
  skipAgent?: boolean;
}

export interface UpdateResult {
  appId: string;
  /** Null when the change was a no-op. */
  commitSha: string | null;
  ship: ShipResult | null;
  summary: string;
}

export function githubDispatcher(github: GitHubCtx): WorkflowDispatcher {
  return {
    dispatch: (repo, workflow, ref, inputs) =>
      dispatchWorkflow(github, repo, workflow, ref, inputs),
  };
}

export async function updateApp(
  store: Store,
  app: App,
  github: GitHubCtx,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  if (!app.repoFullName) {
    throw new Error(`app ${app.id} has no repository yet — provisioning may still be running`);
  }

  const workspace = new GitWorkspace({
    fullName: app.repoFullName,
    token: github.token,
    branch: PROD_BRANCH,
  });

  await workspace.open();

  try {
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

    // Ask git what actually changed, before committing clears the worktree.
    const changedFiles = await workspace.gitChangedFiles();
    if (changedFiles.length === 0) {
      return {
        appId: app.id,
        commitSha: null,
        ship: null,
        summary: "No changes were needed.",
      };
    }

    const pkgAfter = await workspace.read("apps/expo/package.json");
    const deps = diffDependencies(pkgBefore, pkgAfter);

    const commitSha = await workspace.commitAndPush(
      `${opts.instruction.slice(0, 68)}\n\nvia Von`,
    );
    if (!commitSha) {
      return { appId: app.id, commitSha: null, ship: null, summary: "No changes were needed." };
    }

    const ship = await shipChange(
      {
        files: changedFiles,
        addedDependencies: deps.added,
        removedDependencies: deps.removed,
      },
      {
        appId: app.id,
        repoFullName: app.repoFullName,
        channel: app.channel,
        runtimeVersion: app.runtimeVersion,
        branch: PROD_BRANCH,
      },
      githubDispatcher(github),
    );

    if (ship.runtimeVersion !== app.runtimeVersion) {
      await store.updateApp(app.id, { runtimeVersion: ship.runtimeVersion });
    }

    return {
      appId: app.id,
      commitSha,
      ship,
      summary: ship.decision.reason,
    };
  } finally {
    // Always remove the checkout: it holds a clone of a customer's repo on
    // disk, and the process is long-lived.
    await workspace.dispose();
  }
}
