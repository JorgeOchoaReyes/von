import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Running the user's app so they can look at it *before* it ships.
 *
 * The delivery path (docs/ARCHITECTURE.md §12) is: first native build ~10 min,
 * every change after that an OTA in ~1 min. Both are far too slow to be the
 * feedback loop while someone is still deciding what they want. Preview fills
 * that gap — the app runs from the working tree, in a webview, and updates as
 * the agent types.
 *
 * Metro's web target rather than an `expo export` per turn, because export
 * rebuilds the whole bundle from scratch (tens of seconds, every turn) while a
 * dev server pays that cost once per session and then fast-refreshes. The user
 * sees the first turn take a moment and every turn after it feel instant, which
 * is the shape of the loop we want.
 *
 * Behind an interface because a preview is a long-lived child process holding a
 * customer's checkout. Today it runs beside the control plane; the moment that
 * stops being acceptable it moves to a sandboxed worker, and nothing above this
 * file needs to know.
 */
export interface RunningPreview {
  /** Loopback URL of the dev server itself. */
  url: string;
  /** Port it bound to. The proxy needs this; nothing outside should see it. */
  port: number;
  stop(): Promise<void>;
}

export interface PreviewRunner {
  start(dir: string, opts: { appId: string }): Promise<RunningPreview>;
}

/** Ask the OS for a free port. Racy in principle, fine in practice: the gap
 * between closing the probe and Metro binding is microseconds, and a collision
 * surfaces immediately as a start failure rather than as a wrong preview. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

export interface ExpoWebRunnerOptions {
  /** Path of the Expo app inside the repo. Matches the blueprint layout. */
  appDir?: string;
  /** How long to wait for Metro to answer before giving up. */
  readyTimeoutMs?: number;
  /** How long to allow for installing the app's dependencies. */
  installTimeoutMs?: number;
  /** Test seam: replaced with a stub in tests so nothing spawns Metro. */
  spawnServer?: (dir: string, port: number) => ChildProcess;
  probe?: (url: string) => Promise<boolean>;
  /** Test seam for the dependency install. */
  install?: (repoDir: string) => Promise<void>;
}

/**
 * Install the app's dependencies before Metro is asked to bundle anything.
 *
 * A preview session starts from a fresh shallow clone, which has no
 * `node_modules`. Without this, `expo start` exits immediately with a module
 * resolution error and the preview never appears — and the failure looks like
 * "Metro is broken" rather than "nothing was installed".
 *
 * Once per session, not once per turn: the checkout persists, so later turns
 * skip straight to fast refresh. A turn that *adds* a dependency reinstalls,
 * because a lockfile newer than the install is exactly the case where the
 * bundle would otherwise fail on a package that is supposedly there.
 */
const defaultInstall = async (repoDir: string, timeoutMs: number): Promise<void> => {
  const modules = join(repoDir, "node_modules");
  const lock = join(repoDir, "pnpm-lock.yaml");

  if (existsSync(modules) && statSync(modules).mtimeMs >= mtimeOr(lock, 0)) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["install", "--prefer-offline"], {
      cwd: repoDir,
      env: { ...process.env, CI: "1" },
      stdio: "ignore",
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`installing dependencies timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pnpm install failed with code ${code ?? "null"}`));
    });
  });
};

const mtimeOr = (path: string, fallback: number): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return fallback;
  }
};

const defaultSpawn = (dir: string, port: number): ChildProcess =>
  spawn(
    "npx",
    ["expo", "start", "--web", "--port", String(port)],
    {
      cwd: dir,
      // BROWSER=none stops Expo opening a browser on the *server*; CI=1 keeps it
      // non-interactive, so it never sits waiting on a keypress nobody will send.
      env: { ...process.env, BROWSER: "none", CI: "1" },
      stdio: "ignore",
      detached: false,
    },
  );

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
};

export class ExpoWebRunner implements PreviewRunner {
  private readonly opts: ExpoWebRunnerOptions;

  constructor(opts: ExpoWebRunnerOptions = {}) {
    this.opts = opts;
  }

  async start(dir: string, opts: { appId: string }): Promise<RunningPreview> {
    const appDir = join(dir, this.opts.appDir ?? "apps/expo");

    // Before anything else: a fresh clone has no node_modules, and Metro exits
    // instantly without them.
    const installTimeout = this.opts.installTimeoutMs ?? 300_000;
    const install = this.opts.install ?? ((d: string) => defaultInstall(d, installTimeout));
    await install(dir);

    const port = await freePort();
    const spawnServer = this.opts.spawnServer ?? defaultSpawn;
    const probe = this.opts.probe ?? defaultProbe;
    const local = `http://127.0.0.1:${port}`;

    const child = spawnServer(appDir, port);

    let exited: string | null = null;
    child.once("exit", (code, signal) => {
      exited = `preview server exited early (code ${code ?? "null"}, signal ${signal ?? "none"})`;
    });

    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        // Metro spawns workers; give it a chance to take them down with it
        // before resorting to SIGKILL, or the ports stay held.
        const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill("SIGTERM");
      });
    };

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (exited) throw new Error(exited);
      if (await probe(local)) return { url: local, port, stop };
      await new Promise((r) => setTimeout(r, 500));
    }

    // Never leave the child running after a timeout: it holds a port and a
    // checkout, and nothing else has a handle on it once we throw.
    await stop();
    throw new Error(`preview server for ${opts.appId} was not ready in time`);
  }
}
