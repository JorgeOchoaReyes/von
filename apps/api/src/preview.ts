import type { GitWorkspace } from "@von/agent";
import { ExpoWebRunner, PreviewSessions } from "@von/preview";
import type { GitHubCtx } from "@von/provisioning";
import type { Store } from "./store.ts";
import { openWorkspace } from "./update.ts";

/**
 * The control plane's preview sessions.
 *
 * One per process, because a session owns a checkout and a dev server and both
 * must be shared across the requests that make up one conversation.
 *
 * `VON_PREVIEW_BASE` is what makes a preview reachable from a phone. Without it
 * the URL is loopback, which is right for local development and useless for a
 * device — so the default is honest rather than convenient, and production sets
 * a proxy that maps a public host to the session's port.
 */
export function createPreviewSessions(
  store: Store,
  github: () => GitHubCtx,
): PreviewSessions<GitWorkspace> {
  const base = process.env.VON_PREVIEW_BASE;

  const runner = new ExpoWebRunner({
    urlFor: (port, appId) =>
      base ? `${base.replace(/\/$/, "")}/p/${appId}/${port}/` : `http://127.0.0.1:${port}`,
  });

  return new PreviewSessions<GitWorkspace>({
    runner,
    open: async (appId) => {
      const app = await store.getApp(appId);
      if (!app) throw new Error(`no app ${appId}`);
      return openWorkspace(app, github());
    },
    idleMs: Number(process.env.VON_PREVIEW_IDLE_MS ?? 30 * 60_000),
    maxSessions: Number(process.env.VON_PREVIEW_MAX_SESSIONS ?? 24),
  });
}

/**
 * Reap idle sessions on a timer.
 *
 * Sessions are only ever closed explicitly on publish-and-finish or on
 * eviction, and users abandon tabs. Without a sweep the process accumulates
 * checkouts and Metro instances until the host runs out of disk or file
 * descriptors — a failure that shows up as unrelated things breaking.
 */
export function startPreviewSweeper(
  sessions: PreviewSessions<GitWorkspace>,
  everyMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    void sessions
      .sweep()
      .then((closed) => {
        if (closed.length) console.log(`[preview] swept idle sessions: ${closed.join(", ")}`);
      })
      .catch((err) => console.error("[preview] sweep failed", err));
  }, everyMs);

  // Unref'd: a background reaper should never be the reason the process refuses
  // to exit.
  timer.unref?.();
  return () => clearInterval(timer);
}
