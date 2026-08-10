import { classifyChange, nextRuntimeVersion, type ChangeSet, type ReleaseDecision } from "./classify.ts";

/**
 * Turning a decision into an actual delivery.
 *
 * Kept behind an interface so this package stays dependency-free and testable
 * without a network: the control plane supplies a dispatcher backed by GitHub
 * workflow_dispatch.
 */
export interface WorkflowDispatcher {
  dispatch(
    repoFullName: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;
}

export interface ShipTarget {
  appId: string;
  repoFullName: string;
  /** The channel the installed build listens on. */
  channel: string;
  runtimeVersion: string;
  branch: string;
  /**
   * The release record this dispatch belongs to, passed to the workflow so it
   * can report back what actually happened.
   *
   * Without it a release stays `queued` forever with no EAS update group — and
   * the group is the only handle on a published bundle, so rollback would have
   * nothing to republish.
   */
  releaseId: string;
  /**
   * Runtime versions that have a finished binary somewhere.
   *
   * An OTA update only reaches a build whose runtime version matches, so
   * publishing one for a runtime nothing was ever built at succeeds loudly and
   * arrives nowhere. That is the state every app starts in: the first change is
   * almost always pure JavaScript, which classifies as OTA, and the user is
   * told "it will reach your app in about a minute" when there is no app.
   *
   * Omitted means "unknown, assume a build exists" — the pre-existing
   * behaviour, so a caller that has not been taught to pass this is not made
   * worse by the check.
   */
  builtRuntimeVersions?: string[];
}

export interface ShipResult {
  appId: string;
  decision: ReleaseDecision;
  /** What was actually triggered, if anything. */
  dispatched: "eas-update.yml" | "eas-android-apk.yml" | null;
  /** The runtime version after this release. */
  runtimeVersion: string;
  /** Set when nothing was dispatched, explaining why. */
  skipped?: string;
}

export const OTA_WORKFLOW = "eas-update.yml";
export const NATIVE_WORKFLOW = "eas-android-apk.yml";

/**
 * Classify a change and deliver it.
 *
 * The channel is passed explicitly on every OTA dispatch rather than relying on
 * the workflow's default. An update published to a channel the installed build
 * is not listening on succeeds loudly and arrives nowhere — the most confusing
 * possible failure, because everything reports success and the phone never
 * changes.
 */
export async function shipChange(
  change: ChangeSet,
  target: ShipTarget,
  dispatcher: WorkflowDispatcher,
): Promise<ShipResult> {
  const decision = decideRelease(change, target);
  const runtimeVersion = nextRuntimeVersion(target.runtimeVersion, decision);

  if (decision.kind === "none") {
    return {
      appId: target.appId,
      decision,
      dispatched: null,
      runtimeVersion,
      skipped: decision.reason,
    };
  }

  if (decision.kind === "ota") {
    await dispatcher.dispatch(target.repoFullName, OTA_WORKFLOW, target.branch, {
      branch: target.channel,
      release_id: target.releaseId,
      app_id: target.appId,
    });
    return { appId: target.appId, decision, dispatched: OTA_WORKFLOW, runtimeVersion };
  }

  await dispatcher.dispatch(target.repoFullName, NATIVE_WORKFLOW, target.branch, {
    profile: "preview",
    release_id: target.releaseId,
    app_id: target.appId,
  });
  return { appId: target.appId, decision, dispatched: NATIVE_WORKFLOW, runtimeVersion };
}

export interface DeliveryState {
  /** The runtime version the app is currently on. */
  runtimeVersion: string;
  /** See `ShipTarget.builtRuntimeVersions`. */
  builtRuntimeVersions?: string[];
}

/**
 * Classify a change against what is actually installed.
 *
 * `classifyChange` alone answers "does this change the binary?". This adds the
 * question that has to come with it — "is there a binary?" — and both the
 * preview and the publish path go through here so the cost quoted before
 * publishing is the cost that is paid.
 *
 * The first release of every app is a build, whatever it changed.
 *
 * `classifyChange` answers "does this change the binary?" — the right question
 * once a binary exists. Before then it is the wrong one: the honest answer to a
 * pure-JavaScript change on an app nobody has ever built is still "we have to
 * build it", because there is nothing on any phone for an update to reach.
 *
 * The same reasoning covers a subtler case. A native release bumps the runtime
 * version and then fails; the app's recorded runtime has moved but no binary
 * exists at it, and every OTA after that publishes into a channel no installed
 * build is listening on. Both are the same condition — no finished build at
 * this runtime version — so both are handled here rather than special-casing
 * "first release".
 *
 * `none` is left alone deliberately: a backend-only change genuinely does not
 * need a binary, and forcing a ten-minute build for a Firestore rule edit would
 * be a worse lie in the other direction.
 */
export function decideRelease(change: ChangeSet, state: DeliveryState): ReleaseDecision {
  const decision = classifyChange(change);

  if (decision.kind !== "ota") return decision;
  if (state.builtRuntimeVersions === undefined) return decision;
  if (state.builtRuntimeVersions.includes(state.runtimeVersion)) return decision;

  const first = state.builtRuntimeVersions.length === 0;
  return {
    kind: "native",
    reason: first
      ? "First build — about ten minutes. Nothing is installed yet, so there is no app for an over-the-air update to reach. Changes after this one arrive in about a minute."
      : `Needs a build — no finished binary exists at runtime version ${state.runtimeVersion}, so an over-the-air update would publish to a channel nothing is listening on.`,
    triggers: [
      ...decision.triggers,
      `no finished build at runtime ${state.runtimeVersion}`,
    ],
    // The runtime version is already the one nothing was built at. Bumping
    // again would move the target and leave the next OTA in exactly this state.
    requiresRuntimeBump: false,
  };
}
