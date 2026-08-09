import { randomBytes } from "node:crypto";
import type { PreviewRunner, RunningPreview } from "./runner.ts";

/** 128 bits of URL-safe randomness: this token is the whole access check. */
const defaultToken = (): string => randomBytes(16).toString("hex");

/**
 * Preview sessions.
 *
 * The old loop was one clone per request: clone, edit, commit, push, throw the
 * clone away. Preview breaks that, because the thing the user is looking at is
 * an *uncommitted* working tree — it has to survive between requests, from the
 * turn that produced it to the turn where they accept or reject it.
 *
 * So a session is the pair (checkout, running server), keyed by app, held open
 * across turns and torn down on idle. Two properties do the work:
 *
 *   - **One per app.** Two concurrent turns for the same app must edit the same
 *     tree. Two clones would mean the second push silently discards the first's
 *     work, which is the kind of bug a user experiences as "it forgot what I
 *     asked for".
 *   - **Bounded.** Each session is a checkout on disk plus a Metro process, so
 *     they are evicted on idle and capped in number. Left uncapped this leaks
 *     until the host runs out of something.
 */
export interface PreviewWorkspace {
  /** Absolute path of the checkout the preview server serves. */
  readonly path: string;
  dispose(): Promise<void>;
}

/** What the last agent turn left in the working tree, awaiting publish. */
export interface PendingChange {
  files: string[];
  addedDependencies: string[];
  removedDependencies: string[];
  /**
   * What the user asked for. Carried here because publish happens in a later
   * request than the edit, and the commit message should say what the change
   * was for rather than which file happened to sort first.
   */
  label?: string;
}

export interface PreviewSession<W extends PreviewWorkspace> {
  appId: string;
  workspace: W;
  /**
   * Unguessable id for this session, and the only thing that authorises a
   * request to reach it. It addresses the session instead of the app id
   * because an app id is shared, guessable and long-lived; a preview is a
   * running dev server on someone's half-finished code and should stop being
   * reachable the moment the session ends.
   */
  token: string;
  /** Null until the preview server has been started for this session. */
  url: string | null;
  /** Loopback port of the dev server. Internal — never in a client URL. */
  port: number | null;
  createdAt: number;
  lastUsedAt: number;
  /** Null when the tree is clean — nothing to publish. */
  pending: PendingChange | null;
}

export interface PreviewSessionsOptions<W extends PreviewWorkspace> {
  /** Opens a checkout for an app. Supplied by the control plane (a GitWorkspace). */
  open: (appId: string) => Promise<W>;
  runner: PreviewRunner;
  /** Evict a session untouched for this long. */
  idleMs?: number;
  /** Hard cap; the least recently used session is evicted to make room. */
  maxSessions?: number;
  /** Injectable clock so idle behaviour is testable without waiting. */
  now?: () => number;
  /**
   * The URL a client should load, given a session's token and port. The default
   * is loopback, which is right for the machine running the control plane and
   * useless from a phone; production passes one that points at the preview
   * proxy.
   */
  publicUrl?: (s: { appId: string; token: string; port: number }) => string;
  /** Injectable token source, so tests are deterministic. */
  newToken?: () => string;
}

interface Entry<W extends PreviewWorkspace> {
  session: PreviewSession<W>;
  running: RunningPreview | null;
  /** In flight start, so concurrent turns share one server rather than racing. */
  starting: Promise<string> | null;
}

export class PreviewSessions<W extends PreviewWorkspace> {
  private readonly entries = new Map<string, Entry<W>>();
  private readonly opening = new Map<string, Promise<Entry<W>>>();
  /** token -> appId, so the proxy resolves a request in one lookup. */
  private readonly byToken = new Map<string, string>();
  private readonly opts: PreviewSessionsOptions<W>;

  constructor(opts: PreviewSessionsOptions<W>) {
    this.opts = opts;
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The session for an app, opening a checkout if there is not one already. */
  async acquire(appId: string): Promise<PreviewSession<W>> {
    const entry = await this.entry(appId);
    entry.session.lastUsedAt = this.now;
    return entry.session;
  }

  private async entry(appId: string): Promise<Entry<W>> {
    const existing = this.entries.get(appId);
    if (existing) return existing;

    // Two turns arriving together must not both clone. Whoever gets here first
    // publishes the promise; everybody else awaits it.
    const inFlight = this.opening.get(appId);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<Entry<W>> => {
      await this.evictForRoom();
      const workspace = await this.opts.open(appId);
      const token = (this.opts.newToken ?? defaultToken)();
      const entry: Entry<W> = {
        session: {
          appId,
          workspace,
          token,
          url: null,
          port: null,
          createdAt: this.now,
          lastUsedAt: this.now,
          pending: null,
        },
        running: null,
        starting: null,
      };
      this.entries.set(appId, entry);
      this.byToken.set(token, appId);
      return entry;
    })();

    this.opening.set(appId, promise);
    try {
      return await promise;
    } finally {
      // Cleared in `finally` so a failed open does not poison the key: the next
      // attempt gets a fresh clone rather than the cached rejection.
      this.opening.delete(appId);
    }
  }

  /**
   * Ensure a preview server is running for this app and return its URL.
   *
   * Idempotent, and safe to call from concurrent turns: the first call starts
   * the server, the rest wait on the same promise. Starting a second Metro on
   * the same checkout would burn a minute and produce a second URL for the same
   * tree.
   */
  async ensureRunning(appId: string): Promise<string> {
    const entry = await this.entry(appId);
    entry.session.lastUsedAt = this.now;

    if (entry.session.url) return entry.session.url;
    if (entry.starting) return entry.starting;

    const starting = (async () => {
      const running = await this.opts.runner.start(entry.session.workspace.path, { appId });
      entry.running = running;
      entry.session.port = running.port;
      entry.session.url = this.opts.publicUrl
        ? this.opts.publicUrl({ appId, token: entry.session.token, port: running.port })
        : running.url;
      return entry.session.url;
    })();

    entry.starting = starting;
    try {
      return await starting;
    } finally {
      entry.starting = null;
    }
  }

  get(appId: string): PreviewSession<W> | null {
    return this.entries.get(appId)?.session ?? null;
  }

  /**
   * Resolve a session from its token — how the proxy answers "which dev server
   * does this request belong to, and is it allowed to".
   *
   * A lookup rather than a comparison: an unknown token finds nothing, so there
   * is no secret being compared against and nothing to time. Closing a session
   * drops its token, so a stale URL stops resolving rather than landing on
   * whatever now occupies that port.
   */
  getByToken(token: string): PreviewSession<W> | null {
    const appId = this.byToken.get(token);
    if (!appId) return null;
    const entry = this.entries.get(appId);
    if (!entry) return null;
    entry.session.lastUsedAt = this.now;
    return entry.session;
  }

  /** Record what the working tree is holding, for the publish step to ship. */
  setPending(appId: string, pending: PendingChange | null): void {
    const entry = this.entries.get(appId);
    if (!entry) return;
    entry.session.pending = pending;
    entry.session.lastUsedAt = this.now;
  }

  /** Stop the server and delete the checkout. */
  async close(appId: string): Promise<void> {
    const entry = this.entries.get(appId);
    if (!entry) return;
    this.entries.delete(appId);
    this.byToken.delete(entry.session.token);

    // Stop first: the server has the checkout open, and on some platforms
    // deleting a directory out from under a running process is how you get a
    // half-deleted tree and a wedged child.
    try {
      await entry.running?.stop();
    } finally {
      await entry.session.workspace.dispose();
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }

  /**
   * Close sessions idle past the TTL. Called on a timer by the control plane.
   *
   * A session with unpublished changes is evicted like any other — the changes
   * were never committed, so they are lost. That is the honest outcome: keeping
   * a checkout alive indefinitely because a user might come back is how the
   * host fills up. The UI's job is to make "publish" obvious, not to make
   * abandonment free.
   */
  async sweep(): Promise<string[]> {
    const idleMs = this.opts.idleMs ?? 30 * 60_000;
    const cutoff = this.now - idleMs;
    const stale = [...this.entries.values()]
      .filter((e) => e.session.lastUsedAt <= cutoff)
      .map((e) => e.session.appId);

    for (const appId of stale) await this.close(appId);
    return stale;
  }

  private async evictForRoom(): Promise<void> {
    const max = this.opts.maxSessions ?? 24;
    while (this.entries.size >= max) {
      const oldest = [...this.entries.values()].sort(
        (a, b) => a.session.lastUsedAt - b.session.lastUsedAt,
      )[0];
      if (!oldest) return;
      await this.close(oldest.session.appId);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
