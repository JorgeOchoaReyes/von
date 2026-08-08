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
  const decision = classifyChange(change);
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
    });
    return { appId: target.appId, decision, dispatched: OTA_WORKFLOW, runtimeVersion };
  }

  await dispatcher.dispatch(target.repoFullName, NATIVE_WORKFLOW, target.branch, {
    profile: "preview",
  });
  return { appId: target.appId, decision, dispatched: NATIVE_WORKFLOW, runtimeVersion };
}
