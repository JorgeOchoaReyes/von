import type { Release } from "@von/core";
import { findRollbackTarget, NotRollbackableError } from "./rollback.ts";

/**
 * Knowing a release went wrong.
 *
 * Rollback answers "undo it". This answers the question that has to come first,
 * and is the harder one: nobody is watching. An OTA lands on every installed
 * device in about a minute, and if it crashes on launch the person best placed
 * to notice is holding an app that no longer opens.
 *
 * So the app itself reports. A launch that ends in an uncaught error posts one
 * signal, and the control plane attributes it to whichever release those devices
 * are actually running.
 *
 * **These counts are advisory and must never trigger an automatic rollback.**
 * The endpoint that receives them cannot be authenticated — a client app holds
 * no secret worth the name, since anything shipped in a bundle is readable by
 * anyone who has it. So the numbers can be inflated by anyone who cares to. They
 * are good enough to *raise a question* to the person who published the change,
 * and nowhere near good enough to act on unattended. Undo stays a decision.
 */

export interface CrashSignal {
  /** Runtime version of the binary that crashed — how a signal finds its release. */
  runtimeVersion: string;
  /** EAS update group, when the client knows it. Narrows attribution further. */
  updateGroup?: string | null;
}

/**
 * Which release a crash signal belongs to.
 *
 * Update group first when the client reports one: that names an exact bundle.
 * Falling back to runtime version alone is deliberately coarse — a device may
 * not have applied the newest update yet — so it resolves to the newest release
 * those devices *could* be running, which is the one worth asking about.
 *
 * Returns null rather than guessing when nothing matches. A signal attributed to
 * the wrong release is worse than one dropped: it would put a crash count on a
 * bundle that is fine, and invite undoing it.
 */
export function attributeCrash(releases: Release[], signal: CrashSignal): Release | null {
  const ordered = [...releases].sort((a, b) => b.createdAt - a.createdAt);

  if (signal.updateGroup) {
    const exact = ordered.find((r) => r.externalId === signal.updateGroup);
    if (exact) return exact;
  }

  return ordered.find((r) => r.runtimeVersion === signal.runtimeVersion) ?? null;
}

/**
 * A binary someone can put on a phone.
 *
 * OTA releases have no artifact of their own — they land on a binary a native
 * release produced — so "where do I install this?" is never answered by the
 * newest release. It is answered by the newest *native* one that finished.
 */
export interface InstallableBuild {
  releaseId: string;
  url: string;
  /** OTA updates only reach builds on this runtime, so it belongs next to the link. */
  runtimeVersion: string;
  createdAt: number;
}

export interface ReleaseHealth {
  /** The newest release, or null for an app that has never published. */
  latest: Release | null;
  /** The newest installable build, or null before the first one finishes. */
  install: InstallableBuild | null;
  /**
   * A native build is queued or running, so `install` is the *previous* binary
   * and does not contain the change being published. Said out loud because the
   * alternative is a user installing a ten-minute-old APK and reporting that
   * their change never arrived.
   */
  building: boolean;
  /** A store submission is in flight. Play review is not included in that. */
  submitting: boolean;
  /** Crash signals attributed to it. Advisory — see the note above. */
  crashReports: number;
  /** True once the count passes the threshold worth surfacing. */
  suspect: boolean;
  rollback: {
    available: boolean;
    /** The release undo would restore, when there is one. */
    to: string | null;
    /** Why not, in the user's terms, when there is not. */
    reason: string | null;
  };
}

/**
 * Whether the latest release looks healthy, and what could be done about it.
 *
 * The rollback half is computed here rather than left to the caller so the
 * answer is one round trip: a UI that has to ask "is this bad?" and then "can I
 * undo it?" separately will show a button that fails when pressed.
 */
export function assessHealth(releases: Release[], threshold = 3): ReleaseHealth {
  const ordered = [...releases].sort((a, b) => b.createdAt - a.createdAt);
  const latest = ordered[0] ?? null;

  // `succeeded` and not merely "has a URL": a failed build reports back too, and
  // linking to a binary whose build failed is worse than linking to nothing.
  //
  // Store submissions are excluded even though they have an artifact. Theirs is
  // an Android App Bundle, which Play unpacks into per-device APKs — handing one
  // to someone as an install link gives them a file their phone will not open.
  const built = ordered.find(
    (r) => r.status === "succeeded" && r.artifactUrl && r.kind !== "store",
  );

  const health: ReleaseHealth = {
    latest,
    install: built
      ? {
          releaseId: built.id,
          url: built.artifactUrl!,
          runtimeVersion: built.runtimeVersion,
          createdAt: built.createdAt,
        }
      : null,
    building: ordered.some(
      (r) => r.kind === "native" && (r.status === "queued" || r.status === "running"),
    ),
    submitting: ordered.some(
      (r) => r.kind === "store" && (r.status === "queued" || r.status === "running"),
    ),
    crashReports: latest?.crashReports ?? 0,
    // A single report is noise: one device, one bad network moment, one user on
    // an OS nobody tested. A handful in a row is a pattern.
    suspect: (latest?.crashReports ?? 0) >= threshold,
    rollback: { available: false, to: null, reason: null },
  };

  try {
    const { to } = findRollbackTarget(releases);
    health.rollback = { available: true, to: to.id, reason: null };
  } catch (err) {
    health.rollback = {
      available: false,
      to: null,
      reason:
        err instanceof NotRollbackableError ? err.message : (err as Error).message,
    };
  }

  return health;
}
