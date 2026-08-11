import { newResourceRecord, type App } from "@von/core";
import { firestoreMigrateDriver, type PoolStore } from "@von/provisioning";
import type { Store } from "./store.ts";
import { migrateCtx, startGenesis } from "./provision.ts";

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
   * Copy the app's Firestore documents into its new database.
   *
   * The right answer for any app with real users, and the reason it is not the
   * default is honesty rather than caution: the copy is a snapshot taken while
   * the database is live, so writes during the cutover can be lost. Choosing it
   * should be a decision about the app's traffic, not something that happened
   * silently.
   */
  migrateData?: boolean;

  /**
   * Confirmation that the app's existing Firestore data will *not* come with it.
   *
   * The alternative to `migrateData`, and required when it is not set. The
   * pooled database stays where it is: the promoted app points at a brand-new,
   * empty `(default)` database and every document its users created becomes
   * unreachable from the app.
   *
   * That is destructive enough that it cannot be a flag someone forgets.
   */
  acknowledgeDataReset?: boolean;
}

export interface PromotionResult {
  app: App;
  /** The project the app now owns. */
  firebaseProjectId: string;
  /** True when the data was copied across rather than left behind. */
  migrated: boolean;
  /**
   * The pooled database. Still populated either way — a migration copies rather
   * than moves, so the original stays as a fallback until someone deletes it.
   */
  previousDatabase: string | null;
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

  if (!opts.migrateData && !opts.acknowledgeDataReset) {
    throw new PromotionRefused(
      "promotion needs a decision about data: pass migrateData to copy the app's " +
        "Firestore documents into its new database, or acknowledgeDataReset to " +
        "accept that the app starts empty and its users' existing documents stay " +
        "behind in the pool.",
    );
  }

  const migration = opts.migrateData ? migrateCtx() : null;
  if (opts.migrateData && !migration) {
    throw new PromotionRefused(
      "VON_MIGRATION_BUCKET is not configured, so there is nowhere to stage the " +
        "export. Set it, or promote with acknowledgeDataReset.",
    );
  }

  // Read before the switch: afterwards the app's config names the new database
  // and there is nothing left pointing at the old one.
  const previous = await store.getRuntimeConfig(app.id);
  const previousDatabase = previous?.firestoreDatabaseId ?? null;
  const previousProject = previous?.firebase.projectId ?? null;

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

  // After provisioning, before anyone is told the promotion is done. The app
  // is already pointing at the new database by now, so a failure here leaves it
  // empty rather than half-copied — which is why the caller is not told the
  // migration succeeded unless it did.
  let migrated = false;
  if (migration && previousDatabase && previousProject) {
    const driver = firestoreMigrateDriver(migration);
    const spec = {
      appId: app.id,
      fromProjectId: previousProject,
      fromDatabaseId: previousDatabase,
      toProjectId: promoted.firebaseProjectId,
      toDatabaseId: "(default)",
    };

    const key = driver.key(spec);
    // Written to the ledger like any other provisioned resource, so a repeated
    // promotion does not re-export gigabytes and an interrupted one is visible.
    const existing = await store.ledger.get(key);
    if (existing?.state === "ready") {
      migrated = true;
    } else {
      const record = newResourceRecord(key, "firestore.migration", app.id);
      await store.ledger.upsert({ ...record, state: "creating" });
      const outputs = await driver.create(spec);
      await store.ledger.upsert({
        ...record,
        state: "ready",
        externalId: outputs.documentsUri,
        outputs,
      });
      migrated = true;
    }
  }

  console.log(
    `[promote] ${app.id} -> ${promoted.firebaseProjectId} ` +
      (migrated
        ? `(data copied from ${previousDatabase})`
        : `(pooled database ${previousDatabase ?? "none"} left in place)`),
  );

  return {
    app: promoted,
    firebaseProjectId: promoted.firebaseProjectId,
    migrated,
    previousDatabase,
  };
}
