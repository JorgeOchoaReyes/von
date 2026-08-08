import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "./workspace.ts";

const run = promisify(execFile);

export interface GitWorkspaceOptions {
  /** `owner/repo` on GitHub. */
  fullName: string;
  /** Returns a fresh installation token; used for clone and push. */
  token: () => Promise<string>;
  branch?: string;
  /** Commit author. Defaults to the Von bot. */
  author?: { name: string; email: string };
  /**
   * Override the clone URL. Only for tests, which point at a local bare repo
   * so the whole clone -> edit -> commit -> push path can run without network.
   */
  remoteUrl?: string;
}

/**
 * A git-backed workspace: the agent's edits land in a real checkout of the
 * app's repo and are pushed as a commit.
 *
 * A shallow single-branch clone, because the agent only ever needs the current
 * tree — history would be megabytes of transfer per turn for no benefit.
 *
 * The token is passed via an askpass helper rather than embedded in the remote
 * URL, so it never ends up in `.git/config`, in `git remote -v`, or in any
 * error message git prints on failure.
 */
export class GitWorkspace implements Workspace {
  private readonly touched = new Set<string>();
  private root: string | null = null;
  private askpass: string | null = null;
  // Declared as a field rather than a constructor parameter property: Node's
  // --experimental-strip-types runs in strip-only mode and rejects the latter.
  private readonly opts: GitWorkspaceOptions;

  constructor(opts: GitWorkspaceOptions) {
    this.opts = opts;
  }

  private get dir(): string {
    if (!this.root) throw new Error("workspace not opened — call open() first");
    return this.root;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run("git", args, {
      cwd: this.dir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(this.askpass ? { GIT_ASKPASS: this.askpass } : {}),
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }

  async open(): Promise<void> {
    const token = await this.opts.token();
    const base = await mkdtemp(join(tmpdir(), "von-ws-"));

    // Askpass script: git calls this instead of prompting, and the token stays
    // out of the remote URL and therefore out of the repo config and logs.
    this.askpass = join(base, "askpass.sh");
    await writeFile(this.askpass, `#!/bin/sh\nprintf '%s' "$VON_GIT_TOKEN"\n`, {
      mode: 0o700,
    });
    process.env.VON_GIT_TOKEN = token;

    this.root = join(base, "repo");
    const branch = this.opts.branch ?? "master";

    await run(
      "git",
      [
        "clone",
        "--depth", "1",
        "--single-branch",
        "--branch", branch,
        this.opts.remoteUrl ??
          `https://x-access-token@github.com/${this.opts.fullName}.git`,
        this.root,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: this.askpass } },
    );

    const author = this.opts.author ?? { name: "Von", email: "bot@von.app" };
    await this.git(["config", "user.name", author.name]);
    await this.git(["config", "user.email", author.email]);
  }

  /**
   * Resolve a repo-relative path, refusing anything that escapes the checkout.
   *
   * The paths come from a model, so `../../.ssh/id_rsa` and absolute paths are
   * both reachable inputs. This is the boundary that stops a tool call from
   * reading or writing outside the app's own repository.
   */
  private safe(path: string): string {
    const full = resolve(this.dir, path);
    const rel = relative(this.dir, full);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      throw new Error(`path escapes the repository: ${path}`);
    }
    if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
      throw new Error(`refusing to touch git internals: ${path}`);
    }
    return full;
  }

  async list(prefix = ""): Promise<string[]> {
    const out = await this.git(["ls-files"]);
    return out
      .split("\n")
      .filter((p) => p && p.startsWith(prefix))
      .sort();
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.safe(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(path: string, contents: string): Promise<void> {
    const full = this.safe(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
    this.touched.add(path);
  }

  async remove(path: string): Promise<void> {
    await rm(this.safe(path), { force: true });
    this.touched.add(path);
  }

  changedFiles(): string[] {
    return [...this.touched].sort();
  }

  /**
   * Commit and push. Returns the sha, or null when the agent's edits produced
   * no net change — which is common (it rewrote a file to what it already
   * contained) and must not create an empty commit that triggers a release.
   */
  async commitAndPush(message: string): Promise<string | null> {
    await this.git(["add", "-A"]);

    const status = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim() === "") return null;

    await this.git(["commit", "-m", message]);
    const sha = (await this.git(["rev-parse", "HEAD"])).trim();
    await this.git(["push", "origin", `HEAD:${this.opts.branch ?? "master"}`]);
    return sha;
  }

  /**
   * Files git actually reports as changed, which is what the classifier wants.
   *
   * `--untracked-files=all` is load-bearing. Plain `--porcelain` collapses a
   * new directory to a single entry like `apps/`, and the release classifier
   * does not recognise that as a JS path — so it would route to a native build.
   * Every time the agent added a screen, the user would wait ten minutes for a
   * rebuild instead of a minute for an OTA.
   */
  async gitChangedFiles(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    return out
      .split("\n")
      .filter(Boolean)
      // Porcelain v1: two status chars, a space, then the path. Renames appear
      // as "old -> new"; the new path is the one downstream cares about. Paths
      // with unusual characters come back C-quoted.
      .map((line) => {
        const path = line.slice(3).trim();
        const arrow = path.indexOf(" -> ");
        return arrow === -1 ? path : path.slice(arrow + 4);
      })
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? (JSON.parse(p) as string) : p))
      .sort();
  }

  async dispose(): Promise<void> {
    delete process.env.VON_GIT_TOKEN;
    if (this.root) await rm(dirname(this.root), { recursive: true, force: true });
    this.root = null;
  }
}
