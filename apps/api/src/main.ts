import { serve } from "@hono/node-server";
import app from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`von control plane listening on :${port}`);
