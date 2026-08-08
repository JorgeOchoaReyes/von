import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { newRunId } from "@von/core";
import { InMemoryWorkspace, runAgent } from "@von/agent";
import { classifyChange } from "@von/release";
import { createStore } from "./store.ts";
import { startGenesis } from "./provision.ts";

const store = createStore();
const app = new Hono();

app.use("*", cors());

app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Create an app.
 *
 * Returns immediately with the app record and kicks provisioning off in the
 * background — the operating rule from the brief is that long work never blocks
 * the user. The client watches `/v1/apps/:id` (or the SSE stream) for progress.
 */
app.post("/v1/apps", async (c) => {
  const body = await c.req.json<{ tenantId?: string; name?: string; description?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);

  const created = await store.createApp({
    tenantId: body.tenantId ?? "tnt_demo",
    name: body.name,
    description: body.description ?? "",
  });

  void startGenesis(store, created).catch((err) => {
    console.error(`genesis failed for ${created.id}`, err);
  });

  return c.json(created, 201);
});

app.get("/v1/apps", async (c) => {
  const tenantId = c.req.query("tenantId");
  return c.json(await store.listApps(tenantId ?? undefined));
});

app.get("/v1/apps/:id", async (c) => {
  const found = await store.getApp(c.req.param("id"));
  return found ? c.json(found) : c.json({ error: "not found" }, 404);
});

/**
 * Runtime config — fetched by every generated app at boot.
 *
 * This endpoint is the indirection that makes pooled -> dedicated promotion
 * possible without a rebuild (docs/ARCHITECTURE.md §4). It is public and
 * unauthenticated by design: everything in it is a Firebase *web* config, which
 * ships in every client binary anyway. Access control lives in Firestore rules
 * and the GCIP tenant, not in the secrecy of these values.
 */
app.get("/v1/apps/:id/runtime-config", async (c) => {
  const cfg = await store.getRuntimeConfig(c.req.param("id"));
  if (!cfg) return c.json({ error: "not provisioned yet" }, 404);
  return c.json(cfg, 200, { "cache-control": "public, max-age=60" });
});

/** Provisioning state for the admin console. */
app.get("/v1/apps/:id/resources", async (c) => {
  return c.json(await store.ledger.listByApp(c.req.param("id")));
});

/**
 * Chat — the product surface. Streams agent output as SSE so tokens appear as
 * they are produced rather than after the whole turn.
 */
app.post("/v1/apps/:id/chat", async (c) => {
  const appId = c.req.param("id");
  const target = await store.getApp(appId);
  if (!target) return c.json({ error: "not found" }, 404);

  const { message } = await c.req.json<{ message: string }>();
  const runId = newRunId();

  return streamSSE(c, async (stream) => {
    const workspace = new InMemoryWorkspace(); // git-backed checkout in production
    const summary = `You are editing "${target.name}" (${target.id}).\n${target.description}`;

    await stream.writeSSE({ event: "run.start", data: JSON.stringify({ runId }) });

    try {
      for await (const ev of runAgent({
        workspace,
        message,
        appSummary: summary,
        backendTier: target.backendTier,
      })) {
        if (ev.type === "text") {
          await stream.writeSSE({ event: "text", data: JSON.stringify({ text: ev.text }) });
        } else if (ev.type === "tool") {
          await stream.writeSSE({ event: "tool", data: JSON.stringify(ev.tool) });
        } else if (ev.type === "error") {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: ev.text }) });
        } else if (ev.type === "done" && ev.decision) {
          // The routing decision is part of the product surface: the user is
          // told whether this lands in a minute or needs a new build.
          await stream.writeSSE({
            event: "release",
            data: JSON.stringify({
              kind: ev.decision.kind,
              reason: ev.decision.reason,
              files: workspace.changedFiles(),
            }),
          });
        }
      }
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: (err as Error).message }),
      });
    }

    await stream.writeSSE({ event: "run.end", data: JSON.stringify({ runId }) });
  });
});

/** Classify a change set without running the agent — used by CI and the admin UI. */
app.post("/v1/apps/:id/classify", async (c) => {
  const body = await c.req.json<Parameters<typeof classifyChange>[0]>();
  return c.json(classifyChange(body));
});

export default app;
export { store };
