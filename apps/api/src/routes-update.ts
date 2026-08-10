import { Hono } from "hono";
import { rollout } from "@von/release";
import type { GitHubCtx } from "@von/provisioning";
import type { Store } from "./store.ts";
import {
  discardPreview,
  previewChange,
  publishChange,
  rollbackApp,
  submitApp,
  updateApp,
  type Sessions,
} from "./update.ts";

/**
 * The direct make-and-update surface.
 *
 * Chat is the product; these are the same operations without a conversation,
 * for scripts, CI, the admin console, and fleet work. They share `previewChange`
 * and `publishChange`, so a change to how releases are routed applies
 * everywhere at once.
 */
export function updateRoutes(
  store: Store,
  github: () => GitHubCtx,
  sessions: Sessions,
): Hono {
  const app = new Hono();

  /**
   * Apply one instruction and return a preview. Nothing is committed or shipped
   * — `POST /publish` is what does that.
   */
  app.post("/v1/apps/:id/preview", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (!instruction) return c.json({ error: "instruction is required" }, 400);

    try {
      return c.json(await previewChange(store, sessions, target, { instruction }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /** Current preview state: is there a URL to look at, is anything pending. */
  app.get("/v1/apps/:id/preview", async (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return c.json({ appId: id, url: null, pending: null });
    return c.json({
      appId: id,
      url: session.url,
      pending: session.pending,
      startedAt: session.createdAt,
    });
  });

  /** Reject the previewed change and go back to what is live. */
  app.delete("/v1/apps/:id/preview", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    try {
      await discardPreview(sessions, target);
      return c.json({ appId: target.id, discarded: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /** Commit, push and ship what was previewed. */
  app.post("/v1/apps/:id/publish", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    try {
      return c.json(await publishChange(store, sessions, target, github()));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /** What has shipped, newest first. */
  app.get("/v1/apps/:id/releases", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    return c.json(await store.listReleases(target.id));
  });

  /**
   * Undo the last release by republishing the one before it.
   *
   * An OTA reaches installed devices in about a minute with no review step, so
   * this is the recovery path for a bundle that crashes on launch — for a user
   * whose app no longer opens, "describe a fix" is not one.
   */
  app.post("/v1/apps/:id/rollback", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    try {
      const result = await rollbackApp(store, target, github());
      return c.json({
        appId: target.id,
        rolledBack: result.from.id,
        restored: result.to.id,
        summary: `Restored the update from ${new Date(result.to.createdAt).toISOString()}`,
      });
    } catch (err) {
      // A refusal here is a statement about the app's history — the last
      // release was native, or there is nothing earlier to go back to — so it
      // is a 409, not a 500.
      const status = (err as Error).name === "NotRollbackableError" ? 409 : 500;
      return c.json({ error: (err as Error).message }, status);
    }
  });

  /**
   * Put the app on Play's internal testing track.
   *
   * Deliberately its own call rather than a flag on publish. Publishing is
   * routine and happens many times a day; submitting is a decision about who
   * gets to see the app, costs a build of its own, and depends on a Play
   * listing that a human had to create. Folding it into publish would make
   * every ordinary change ten minutes slower and occasionally push something to
   * testers nobody meant to show them.
   */
  app.post("/v1/apps/:id/submit", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    try {
      return c.json(await submitApp(store, target, github()));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * Preview and publish in one call.
   *
   * Kept for scripts and CI, where there is no user to look at a preview. The
   * interactive surfaces deliberately do not use it.
   */
  app.post("/v1/apps/:id/update", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (!instruction) return c.json({ error: "instruction is required" }, 400);

    try {
      return c.json(await updateApp(store, sessions, target, github(), { instruction }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * Apply one instruction across many apps.
   *
   * This is how a blueprint fix or dependency bump reaches apps that were
   * already generated — the template only shapes apps created *after* it
   * changed, so without this every existing app silently drifts.
   *
   * Returns a summary rather than streaming: a rollout across thousands of
   * apps outlives any single HTTP request, so the durable record is the
   * per-app outcome list.
   */
  app.post("/v1/fleet/update", async (c) => {
    const body = await c.req.json<{
      instruction?: string;
      tenantId?: string;
      appIds?: string[];
      concurrency?: number;
      dryRun?: boolean;
    }>();

    if (!body.instruction) return c.json({ error: "instruction is required" }, 400);

    const all = await store.listApps(body.tenantId);
    const targets = body.appIds
      ? all.filter((a) => body.appIds!.includes(a.id))
      : all;

    // Apps still provisioning have no repo to edit yet. Skipping them is
    // correct — they will be generated from the current blueprint anyway.
    const eligible = targets.filter((a) => a.repoFullName);

    if (body.dryRun) {
      return c.json({
        dryRun: true,
        wouldUpdate: eligible.map((a) => ({ id: a.id, name: a.name, repo: a.repoFullName })),
        skipped: targets.length - eligible.length,
      });
    }

    const summary = await rollout(
      eligible.map((a) => ({ appId: a.id })),
      async (item) => {
        const target = await store.getApp(item.appId);
        if (!target) throw new Error("app disappeared mid-rollout");
        return updateApp(store, sessions, target, github(), {
          instruction: body.instruction!,
        });
      },
      {
        concurrency: body.concurrency ?? 4,
        // A systemic failure — bad instruction, expired token — should stop
        // rather than repeat itself across the whole fleet.
        abortAfterFailures: 5,
        onProgress: (done, total, last) =>
          console.log(`[fleet] ${done}/${total} ${last.appId} ${last.status}`),
      },
    );

    return c.json(summary);
  });

  return app;
}
