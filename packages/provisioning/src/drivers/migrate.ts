import { RetryableError, TerminalError, assertOk, type Driver } from "../driver.ts";
import type { GoogleAuth } from "./google.ts";

/**
 * Copying an app's Firestore data from its pooled database to its own.
 *
 * Promotion provisions the new backend; this is what stops promotion from being
 * a data reset. Without it, every document a customer's users created stays in
 * the pool while the app talks to an empty database.
 *
 * **Managed export/import, not a document-by-document copy.** Reading and
 * rewriting every document through the API is O(n) requests, bills a read and a
 * write for each one, and takes hours on anything real. Firestore's own
 * `exportDocuments` / `importDocuments` are server-side bulk operations that
 * cost a fraction and are what Google supports for exactly this. The price is a
 * GCS bucket in the middle, which is why `VON_MIGRATION_BUCKET` exists.
 *
 * ## The honest limitation
 *
 * An export is a **snapshot, and not a consistent one** — Firestore does not
 * freeze the database while exporting, so documents written during the export
 * may or may not be included. Anything written to the pooled database *after*
 * the export begins is not in the copy, and once the app switches over those
 * writes are stranded.
 *
 * For an app with live users that means a cutover window during which writes
 * can be lost. The platform does not currently freeze writes, so this is
 * suitable for apps with light or paused traffic and is not yet a zero-loss
 * migration. Saying so is the point: silently losing a day of a user's data
 * would be far worse than refusing.
 */

export interface MigrateCtx {
  auth: GoogleAuth;
  /**
   * GCS bucket the export is staged through, without the `gs://` prefix. Must
   * be in the same location as both databases — Firestore refuses to export
   * across locations.
   */
  bucket: string;
}

export interface MigrateSpec {
  appId: string;
  /** Project holding the pooled database. */
  fromProjectId: string;
  fromDatabaseId: string;
  /** Project the app is being promoted into. */
  toProjectId: string;
  toDatabaseId: string;
}

export interface MigrateOutputs extends Record<string, unknown> {
  /** Where the snapshot was staged, kept so a failed import can be retried. */
  exportPrefix: string;
  documentsUri: string;
}

const FIRESTORE = "https://firestore.googleapis.com/v1";

async function call(
  ctx: MigrateCtx,
  url: string,
  init: RequestInit & { context: string },
): Promise<any> {
  const token = await ctx.auth.accessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  await assertOk(res, init.context);
  return res.status === 204 ? null : res.json();
}

/**
 * Wait for an export or import to finish.
 *
 * These are minutes, not seconds, and the orchestrator's retry loop is the wrong
 * tool: retrying would start a *second* export rather than resume this one.
 */
async function awaitFirestoreOperation(
  ctx: MigrateCtx,
  projectId: string,
  opName: string,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const op = await call(ctx, `${FIRESTORE}/${opName}`, {
      method: "GET",
      context: `poll ${opName}`,
    });

    if (op.done) {
      if (op.error) {
        throw new TerminalError(`migration operation failed: ${JSON.stringify(op.error)}`);
      }
      return op.response ?? op.metadata ?? {};
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  // Retryable rather than terminal: the operation is still running server-side,
  // and a later attempt can pick it up rather than starting from nothing.
  throw new RetryableError(
    `migration of ${projectId} did not finish within ${timeoutMs}ms; it may still be running`,
  );
}

export function firestoreMigrateDriver(
  ctx: MigrateCtx,
  timeoutMs = 30 * 60_000,
): Driver<MigrateSpec, MigrateOutputs> {
  return {
    kind: "firestore.migration",

    /**
     * Keyed by both ends of the copy.
     *
     * A migration is a movement between two specific databases, so re-running
     * promotion for the same pair short-circuits — but a *different* pair, if an
     * app is ever moved again, is correctly a new operation.
     */
    key: (s) =>
      `firestore.migrate:${s.appId}:${s.fromProjectId}/${s.fromDatabaseId}->${s.toProjectId}/${s.toDatabaseId}`,

    /**
     * Always null. Whether an export exists in the bucket says nothing about
     * whether the import ran, and the ledger already prevents a repeat. A copy
     * that runs twice is wasteful but not wrong — the import overwrites by
     * document id — so this errs toward doing the work rather than skipping it.
     */
    async read() {
      return null;
    },

    async create(spec) {
      // Namespaced by app and target so two migrations cannot collide in the
      // bucket, and so a stranded export can be traced back to its app.
      const exportPrefix = `gs://${ctx.bucket}/migrations/${spec.appId}/${spec.toDatabaseId}`;

      const exportOp = await call(
        ctx,
        `${FIRESTORE}/projects/${spec.fromProjectId}/databases/${encodeURIComponent(spec.fromDatabaseId)}:exportDocuments`,
        {
          method: "POST",
          context: "export pooled database",
          // No collectionIds filter: the whole database moves, and listing
          // collections would mean knowing the app's data model, which the
          // platform deliberately does not.
          body: JSON.stringify({ outputUriPrefix: exportPrefix }),
        },
      );

      const done = await awaitFirestoreOperation(
        ctx,
        spec.fromProjectId,
        exportOp.name,
        timeoutMs,
      );

      // Firestore writes into a timestamped subdirectory and reports the exact
      // one. Importing the prefix we asked for would fail, or pick up an older
      // export sitting beside it.
      const documentsUri = done.outputUriPrefix ?? exportOp.metadata?.outputUriPrefix;
      if (!documentsUri) {
        throw new TerminalError(
          `export of ${spec.fromDatabaseId} reported no output location; nothing to import`,
        );
      }

      const importOp = await call(
        ctx,
        `${FIRESTORE}/projects/${spec.toProjectId}/databases/${encodeURIComponent(spec.toDatabaseId)}:importDocuments`,
        {
          method: "POST",
          context: "import into dedicated database",
          body: JSON.stringify({ inputUriPrefix: documentsUri }),
        },
      );

      await awaitFirestoreOperation(ctx, spec.toProjectId, importOp.name, timeoutMs);

      return { exportPrefix, documentsUri };
    },
  };
}
