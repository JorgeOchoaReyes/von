import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { newRunId } from "@von/core";
import { classifyChange } from "@von/release";
import { authOptionsFromEnv, requireApiKey } from "./auth.ts";
import { createPersistence } from "./store.ts";
import { githubCtx, startGenesis } from "./provision.ts";
import { previewChange } from "./update.ts";
import { createPreviewSessions, startPreviewSweeper } from "./preview.ts";
import { previewProxy } from "./proxy.ts";
import { updateRoutes } from "./routes-update.ts";

const { store, pools, durable } = await createPersistence();
const sessions = createPreviewSessions(store, githubCtx);
startPreviewSweeper(sessions);

const app = new Hono();

/**
 * Preview traffic first, before anything else looks at the path.
 *
 * A request to `<token>.preview.von.app` carries the *generated app's* path —
 * `/index.bundle`, `/assets/…` — which must never be matched against the
 * control plane's routes. Requests to the control plane's own host fall
 * through untouched.
 */
const proxyPreview = previewProxy(sessions);
app.use("*", async (c, next) => {
  const proxied = await proxyPreview(c.req.raw);
  if (proxied) return proxied;
  await next();
});

app.use("*", cors());

// Everything below spends money — GCP projects, repos, agent tokens. The gate
// goes above every route rather than on each one, so a route added later is
// protected by default instead of by remembering.
app.use("*", requireApiKey(authOptionsFromEnv()));

// The direct (non-chat) make-and-update surface: preview, publish, update and
// fleet update. Same code path as chat, no conversation required.
app.route("/", updateRoutes(store, githubCtx, sessions));

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    // Whether persistence is durable is the single most consequential fact
    // about a running control plane, so it is reported rather than inferred.
    durable,
    previews: sessions.size,
  }),
);

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

  void startGenesis(store, pools, created).catch((err) => {
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
 *
 * A chat turn ends in a *preview*, never in a release. The user iterates as
 * long as they like against a running copy of their app and then presses
 * publish, which is `POST /v1/apps/:id/publish`.
 */
app.post("/v1/apps/:id/chat", async (c) => {
  const appId = c.req.param("id");
  const target = await store.getApp(appId);
  if (!target) return c.json({ error: "not found" }, 404);

  const { message } = await c.req.json<{ message: string }>();
  const runId = newRunId();

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "run.start", data: JSON.stringify({ runId }) });

    try {
      const result = await previewChange(sessions, target, {
        instruction: message,
        onEvent: (ev) => {
          // Fire-and-forget: the agent generator must not stall on the socket.
          if (ev.type === "text") {
            void stream.writeSSE({ event: "text", data: JSON.stringify({ text: ev.text }) });
          } else if (ev.type === "tool") {
            void stream.writeSSE({ event: "tool", data: JSON.stringify(ev.tool) });
          } else if (ev.type === "error") {
            void stream.writeSSE({ event: "error", data: JSON.stringify({ message: ev.text }) });
          }
        },
      });

      // Both halves of the answer in one frame: what it looks like now, and
      // what publishing it would cost — a minute for an OTA, ten for a build.
      // The user decides with that in front of them, not after the fact.
      await stream.writeSSE({
        event: "preview",
        data: JSON.stringify({
          url: result.previewUrl,
          error: result.previewError,
          kind: result.decision.kind,
          reason: result.summary,
          files: result.changedFiles,
          publishable: result.changedFiles.length > 0,
        }),
      });
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
export { store, pools, sessions };
