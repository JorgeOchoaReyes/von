import { connect } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { tokenFromHost } from "@von/preview";

/**
 * The preview proxy.
 *
 * A preview session's dev server binds to a loopback port, which is right for
 * the machine running the control plane and useless from a phone. This maps a
 * public origin — `<token>.preview.von.app` — onto that port.
 *
 * It is a pass-through, not a rewriter: the session gets a whole origin of its
 * own (see routing.ts), so Metro's root-absolute URLs, its HMR socket and its
 * asset paths all work unmodified. The only decisions made here are *which*
 * session a request belongs to and *whether* it may reach it.
 */

/**
 * All the proxy needs: which port a token resolves to. Deliberately narrower
 * than `PreviewSessions` — routing bytes has no business knowing about
 * checkouts, agents or pending changes.
 */
export interface PreviewLookup {
  getByToken(token: string): { port: number | null } | null;
}

/** Hop-by-hop headers: meaningful to one connection, wrong to forward. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const strip = (headers: Headers): Headers => {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value);
  });
  return out;
};

export function previewHost(): string | null {
  return process.env.VON_PREVIEW_HOST ?? null;
}

/**
 * Handle a request addressed to a preview origin, or return null if it is not
 * one — in which case it is an ordinary control-plane request.
 *
 * Returned as a function rather than a Hono route because it has to run before
 * routing: a preview request's path is the *app's* path (`/index.bundle`,
 * `/assets/...`), which must not be matched against the control plane's routes.
 */
export function previewProxy(sessions: PreviewLookup, host = previewHost()) {
  return async (req: Request): Promise<Response | null> => {
    if (!host) return null;

    const token = tokenFromHost(req.headers.get("host") ?? undefined, host);
    if (!token) return null;

    const session = sessions.getByToken(token);
    if (!session?.port) {
      // 404 rather than 502: from the client's side an expired session and a
      // wrong token are the same thing, and saying which is which would confirm
      // that a token exists.
      return new Response("This preview is no longer running.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const url = new URL(req.url);
    const target = `http://127.0.0.1:${session.port}${url.pathname}${url.search}`;

    const headers = strip(req.headers);
    // Metro answers on loopback; a forwarded public Host confuses its dev
    // middleware and its CORS checks.
    headers.set("host", `127.0.0.1:${session.port}`);

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        // Required by undici to stream a request body rather than buffer it.
        ...(req.body ? { duplex: "half" } : {}),
      } as RequestInit);

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: strip(upstream.headers),
      });
    } catch (err) {
      return new Response(`Preview is starting or unreachable: ${(err as Error).message}`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}

/**
 * Forward WebSocket upgrades to the session's dev server.
 *
 * Without this the page loads and then never changes: Metro pushes fast-refresh
 * over a socket, which is the entire reason preview feels instant after the
 * first turn. `fetch` cannot express an upgrade, so this pipes the raw
 * connection instead — protocol-agnostic, and it costs nothing to be.
 */
export function attachPreviewUpgrade(
  server: Server,
  sessions: PreviewLookup,
  host = previewHost(),
): void {
  if (!host) return;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const token = tokenFromHost(req.headers.host, host);
    const session = token ? sessions.getByToken(token) : null;

    if (!session?.port) {
      socket.destroy();
      return;
    }

    const upstream = connect(session.port, "127.0.0.1", () => {
      // Replay the upgrade request verbatim, then get out of the way.
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    // Either side going away must take the other with it, or the process
    // accumulates half-open sockets for every preview a user ever opened.
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
}
