import type { Release } from "@von/core";
import type { WorkflowDispatcher } from "./ship.ts";

/**
 * Undoing a release.
 *
 * An OTA reaches every installed device in about a minute, with no review step
 * between an agent's diff and a user's phone. That speed is the product, and it
 * is also why undo has to exist: without it, the recovery path for a bundle that
 * crashes on launch is "write another change and hope", performed by someone
 * whose app no longer opens.
 *
 * Rolling back is a *forward* action, not a deletion. EAS Update has no notion
 * of un-publishing; the fix is to publish the previous bundle again so it
 * becomes the newest on the channel. So a rollback is itself a release, recorded
 * like any other, and the bad one is marked rather than removed — the record of
 * what went wrong is the useful part.
 */

export const ROLLBACK_WORKFLOW = "eas-rollback.yml";

export interface RollbackTarget {
  appId: string;
  repoFullName: string;
  branch: string;
}

export class NotRollbackableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRollbackableError";
  }
}

/**
 * The release a rollback should restore: the newest successful OTA *before* the
 * current one, on the same runtime version.
 *
 * The runtime version constraint is the subtle part. An OTA only reaches builds
 * whose runtime version matches, so republishing a bundle from before a native
 * change would publish to devices that cannot run it — or, worse, silently
 * reach nobody while reporting success. If the last release bumped the runtime
 * version, there is no OTA path back and the honest answer is to say so.
 */
export function findRollbackTarget(releases: Release[]): {
  from: Release;
  to: Release;
} {
  const ordered = [...releases].sort((a, b) => b.createdAt - a.createdAt);
  const current = ordered[0];

  if (!current) throw new NotRollbackableError("this app has never been published");

  if (current.isRollback) {
    throw new NotRollbackableError(
      "the last release was already a rollback; publish a fix rather than rolling back again",
    );
  }

  // Checked before looking for a target, not after. A native change lives in
  // the installed binary — republishing an older JS bundle does not undo it,
  // and in the usual case where the build also bumped the runtime version, the
  // republished bundle would not even reach the new binary. Either way the
  // honest answer is that this needs another build.
  if (current.kind === "native") {
    throw new NotRollbackableError(
      "the last release was a native build; rolling it back needs a new build, not an update",
    );
  }

  const previous = ordered
    .slice(1)
    .find(
      (r) =>
        r.kind === "ota" &&
        r.status === "succeeded" &&
        r.runtimeVersion === current.runtimeVersion &&
        !r.rolledBackBy,
    );

  if (!previous) {
    throw new NotRollbackableError(
      `no earlier successful update exists on runtime version ${current.runtimeVersion}`,
    );
  }

  return { from: current, to: previous };
}

export interface RollbackResult {
  from: Release;
  to: Release;
  dispatched: string;
}

/**
 * Republish an earlier bundle to the channel.
 *
 * The update *group* is what identifies a published bundle to EAS, so it is
 * carried on the release record as `externalId`. Without it there is nothing to
 * republish — which is why a release missing one fails here rather than
 * dispatching a workflow that would fail obscurely in the app's own CI.
 */
export async function rollback(
  releases: Release[],
  target: RollbackTarget,
  dispatcher: WorkflowDispatcher,
): Promise<RollbackResult> {
  const { from, to } = findRollbackTarget(releases);

  if (!to.externalId) {
    throw new NotRollbackableError(
      `release ${to.id} has no update group recorded, so there is nothing to republish`,
    );
  }

  await dispatcher.dispatch(target.repoFullName, ROLLBACK_WORKFLOW, target.branch, {
    group: to.externalId,
    channel: to.channel,
  });

  return { from, to, dispatched: ROLLBACK_WORKFLOW };
}
