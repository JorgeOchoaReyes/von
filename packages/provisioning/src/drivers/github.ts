import { createRequire } from "node:module";
import { assertOk, TerminalError, type Driver } from "../driver.ts";

/**
 * libsodium-wrappers ships an ESM build whose entrypoint imports a sibling file
 * that is not published, so `import sodium from "libsodium-wrappers"` fails to
 * resolve under Node. Loading the CJS build works and is what the package
 * actually tests against. Deferred so importing this module stays cheap.
 */
type Sodium = {
  ready: Promise<void>;
  from_base64(input: string, variant: number): Uint8Array;
  to_base64(input: Uint8Array, variant: number): string;
  from_string(input: string): Uint8Array;
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  base64_variants: { ORIGINAL: number };
};

let sodiumPromise: Promise<Sodium> | null = null;

async function getSodium(): Promise<Sodium> {
  sodiumPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const mod = require("libsodium-wrappers") as Sodium;
    await mod.ready;
    return mod;
  })();
  return sodiumPromise;
}

/**
 * GitHub drivers. These automate DEPLOY.md §3.3 (repo secrets) and replace the
 * manual "create a repo and copy the template into it" step.
 *
 * Auth: a GitHub App installation token scoped to the platform's org. An App
 * (not a PAT) matters at scale — installation tokens get a per-installation
 * rate limit, so one noisy tenant cannot exhaust the budget for everyone.
 */
export interface GitHubCtx {
  /** Returns a fresh installation access token. */
  token(): Promise<string>;
  /** Org that owns generated repos, e.g. `von-apps`. */
  org: string;
  /** `owner/repo` of the blueprint repo, marked as a template on GitHub. */
  templateRepo: string;
}

async function gh(
  ctx: GitHubCtx,
  path: string,
  init: RequestInit & { context: string },
): Promise<any> {
  const token = await ctx.token();
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  await assertOk(res, init.context);
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface RepoSpec {
  appId: string;
  name: string;
  description: string;
  isPrivate: boolean;
}

export interface RepoOutputs extends Record<string, unknown> {
  externalId: string;
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
}

export function repoDriver(ctx: GitHubCtx): Driver<RepoSpec, RepoOutputs> {
  const toOutputs = (repo: any): RepoOutputs => ({
    externalId: String(repo.id),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? "main",
    cloneUrl: repo.clone_url,
  });

  return {
    kind: "github.repo",
    key: (s) => `github.repo:${s.appId}`,

    async read(spec) {
      const token = await ctx.token();
      const res = await fetch(`https://api.github.com/repos/${ctx.org}/${spec.name}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
      if (res.status === 404) return null;
      await assertOk(res, "read repo");
      return toOutputs(await res.json());
    },

    async create(spec) {
      // Generating from a template repo is one API call and gives the new repo
      // a full history-free copy of the blueprint. The generator package then
      // pushes the per-app parameterisation as the first real commit.
      const repo = await gh(ctx, `/repos/${ctx.templateRepo}/generate`, {
        method: "POST",
        context: "generate repo from template",
        body: JSON.stringify({
          owner: ctx.org,
          name: spec.name,
          description: spec.description,
          private: spec.isPrivate,
          include_all_branches: false,
        }),
      });
      return toOutputs(repo);
    },

    async destroy(_spec, outputs) {
      await gh(ctx, `/repos/${outputs.fullName}`, {
        method: "DELETE",
        context: "delete repo",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Actions secrets
// ---------------------------------------------------------------------------

export interface SecretsSpec {
  appId: string;
  fullName: string;
  /** name -> plaintext value. Encrypted client-side before upload. */
  secrets: Record<string, string>;
}

/**
 * Writes the three secrets the generated app's workflows need
 * (`GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `EXPO_TOKEN`) — the step that
 * DEPLOY.md asks a human to do by pasting JSON into a browser.
 *
 * Values are sealed with libsodium against the repo's public key, so the
 * plaintext never appears in a GitHub request body.
 */
export function repoSecretsDriver(ctx: GitHubCtx): Driver<SecretsSpec, Record<string, unknown>> {
  return {
    kind: "github.secret",
    key: (s) => `github.secret:${s.appId}`,

    // Secret values are write-only on GitHub; presence tells us nothing about
    // whether the value is current, so we always re-write. Cheap and idempotent.
    async read() {
      return null;
    },

    async create(spec) {
      const sodium = await getSodium();

      const pk = await gh(ctx, `/repos/${spec.fullName}/actions/secrets/public-key`, {
        method: "GET",
        context: "get repo public key",
      });

      const keyBytes = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);

      for (const [name, value] of Object.entries(spec.secrets)) {
        if (!value) throw new TerminalError(`secret "${name}" has an empty value`);
        const sealed = sodium.crypto_box_seal(sodium.from_string(value), keyBytes);
        await gh(ctx, `/repos/${spec.fullName}/actions/secrets/${name}`, {
          method: "PUT",
          context: `put secret ${name}`,
          body: JSON.stringify({
            encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
            key_id: pk.key_id,
          }),
        });
      }

      return { externalId: spec.fullName, names: Object.keys(spec.secrets) };
    },
  };
}

/** Dispatch a workflow — how the control plane triggers builds and OTA updates. */
export async function dispatchWorkflow(
  ctx: GitHubCtx,
  fullName: string,
  workflowFile: string,
  ref: string,
  inputs: Record<string, string> = {},
): Promise<void> {
  await gh(ctx, `/repos/${fullName}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    context: `dispatch ${workflowFile}`,
    body: JSON.stringify({ ref, inputs }),
  });
}
