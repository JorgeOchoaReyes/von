import { Hono } from "hono";
import { rollout } from "@von/release";
import type { GitHubCtx } from "@von/provisioning";
import type { Store } from "./store.ts";
import { updateApp } from "./update.ts";

/**
 * The direct make-and-update surface.
 *
 * Chat is the product; these are the same operations without a conversation,
 * for scripts, CI, the admin console, and fleet work. They share `updateApp`,
 * so a change to how releases are routed applies everywhere at once.
 */
export function updateRoutes(store: Store, github: () => GitHubCtx): Hono {
  const app = new Hono();

  /** Apply one instruction to one app, synchronously. */
  app.post("/v1/apps/:id/update", async (c) => {
    const target = await store.getApp(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);

    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (!instruction) return c.json({ error: "instruction is required" }, 400);

    try {
      return c.json(await updateApp(store, target, github(), { instruction }));
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
        return updateApp(store, target, github(), { instruction: body.instruction! });
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
