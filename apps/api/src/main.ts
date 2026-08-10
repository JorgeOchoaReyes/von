import { serve } from "@hono/node-server";
import app, { sessions } from "./server.ts";
import { attachPreviewUpgrade, previewHost } from "./proxy.ts";

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port });

// Fast refresh arrives over a WebSocket, which `fetch` cannot express — without
// this the preview loads once and then never changes as the agent works.
attachPreviewUpgrade(server as unknown as import("node:http").Server, sessions);

const host = previewHost();
console.log(`von control plane listening on :${port}`);
console.log(
  host
    ? `previews served at https://<token>.${host}`
    : "previews are loopback-only — set VON_PREVIEW_HOST to reach them from a device",
);
