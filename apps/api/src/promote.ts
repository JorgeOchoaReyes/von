import type { App } from "@von/core";
import type { PoolStore } from "@von/provisioning";
import type { Store } from "./store.ts";
import { startGenesis } from "./provision.ts";

/**
 * Moving an app from the shared pool to its own Firebase project.
 *
 * This is the Tier 0 -> Tier 1 step from docs/ARCHITECTURE.md §3, and the thing
 * that makes it cheap is §4: the app fetches its backend config at boot rather
 * than having it baked into the bundle. So promotion changes what
 * `/runtime-config` returns, and the installed app picks it up on its next
 * launch — no rebuild, no reinstall, no store review.
 *
 * Genesis does the provisioning. It is idempotent, so re-running it against an
 * app whose tier has changed creates exactly what the new tier needs and skips
 * everything already built: the repository, the EAS project and the update
 * channel are all reused untouched.
 *
 * The one thing promotion does **not** do is move data.
 */

export class PromotionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionRefused";
  }
}

export interface PromoteOptions {
  /**
   * Confirmation that the app's existing Firestore data will not come with it.
   *
   * Required, and deliberately not defaulted. The pooled database stays where
   * it is: the promoted app points at a brand-new, empty `(default)` database
   * in its own project, and every document its users have created becomes
   * unreachable from the app.
   *
   * That is destructive enough that it cannot be a flag someone forgets. Once
   * migration exists this becomes the fallback rather than the only path.
   */
  acknowledgeDataReset?: boolean;
}

export interface PromotionResult {
  app: App;
  /** The project the app now owns. */
  firebaseProjectId: string;
  /** The pooled database left behind, so it can be found and migrated later. */
  abandonedDatabase: string | null;
}

export async function promoteApp(
  store: Store,
  pools: PoolStore,
  app: App,
  opts: PromoteOptions = {},
): Promise<PromotionResult> {
  if (app.backendTier === "dedicated") {
    throw new PromotionRefused(`${app.id} already has its own Firebase project`);
  }

  if (!app.repoFullName) {
    // Promotion re-runs genesis, which expects the repo steps to have completed.
    // Better to say so than to half-provision an app that never finished.
    throw new PromotionRefused(
      `${app.id} has not finished provisioning yet — retry once it has a repository`,
    );
  }

  if (!opts.acknowledgeDataReset) {
    throw new PromotionRefused(
      "promotion does not move Firestore data: the app will point at a new, empty " +
        "database and its users' existing documents will be unreachable. " +
        "Retry with acknowledgeDataReset to accept that.",
    );
  }

  // Recorded before the switch, because after it the app no longer knows where
  // its old data lives — and somebody will eventually want to migrate it.
  const previous = await store.getRuntimeConfig(app.id);
  const abandonedDatabase = previous?.firestoreDatabaseId ?? null;

  // Flip the tier first so genesis's `when` guards select the dedicated steps.
  // If provisioning then fails, the app is left marked dedicated with the plan
  // partially applied — which is the resumable state, not a broken one: the
  // ledger records what exists and a re-run continues from there.
  const promoting = await store.updateApp(app.id, { backendTier: "dedicated" });

  await startGenesis(store, pools, promoting);

  const promoted = await store.getApp(app.id);
  if (!promoted?.firebaseProjectId) {
    throw new Error(
      `promotion of ${app.id} finished without a Firebase project — check the resource ledger`,
    );
  }

  console.log(
    `[promote] ${app.id} -> ${promoted.firebaseProjectId}` +
      (abandonedDatabase ? ` (pooled database ${abandonedDatabase} left in place)` : ""),
  );

  return {
    app: promoted,
    firebaseProjectId: promoted.firebaseProjectId,
    abandonedDatabase,
  };
}
