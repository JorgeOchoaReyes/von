import { assertNoUnresolvedTokens, generateRepo, type BlueprintVars } from "@von/generator";
import { TerminalError, type Driver } from "../driver.ts";

/**
 * Turning the blueprint copy into *this app's* repository.
 *
 * `repoDriver` creates the repo with GitHub's template-generate, which copies
 * the blueprint verbatim — `{{APP_NAME}}`, `{{EAS_PROJECT_ID}}` and all. Without
 * this step the generated repo is a template, not an app: it does not build, its
 * workflows trigger on a branch named `{{DEFAULT_BRANCH}}`, and it would fetch
 * its backend config from a URL that is a literal token.
 *
 * So this is the first real commit. It runs last among the repo steps because
 * it needs values that only exist once the EAS project and the backend do.
 *
 * `assertNoUnresolvedTokens` is the guard, and it is the whole point: a token
 * that survives is a per-app value that leaked, and the way that eventually
 * shows up is one tenant's app talking to another tenant's backend.
 */

/** The minimum a checkout has to do for this driver. */
export interface RepoCheckout {
  list(prefix?: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  commitAndPush(message: string): Promise<string | null>;
  dispose(): Promise<void>;
}

/**
 * Injected rather than imported, so `@von/provisioning` does not depend on the
 * agent package for a git implementation. The control plane supplies one.
 */
export interface HydrateCtx {
  open(fullName: string, branch: string): Promise<RepoCheckout>;
  branch: string;
}

export interface HydrateSpec {
  appId: string;
  fullName: string;
  vars: BlueprintVars;
}

export interface HydrateOutputs extends Record<string, unknown> {
  /** Null when the repo was already hydrated and nothing changed. */
  commitSha: string | null;
  filesChanged: number;
}

/**
 * Extensions whose bytes must not be run through a text substitution. The
 * blueprint is all text today; an icon added tomorrow would otherwise be
 * silently corrupted by a round trip through utf-8.
 */
const BINARY = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "icns",
  "ttf", "otf", "woff", "woff2",
  "zip", "gz", "jar", "keystore", "jks", "p12", "mobileprovision",
  "pdf", "mp3", "mp4", "wav",
]);

const isBinary = (path: string): boolean => {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext !== undefined && BINARY.has(ext);
};

export function repoHydrateDriver(ctx: HydrateCtx): Driver<HydrateSpec, HydrateOutputs> {
  return {
    kind: "github.hydrate",
    /**
     * Keyed by the backend it wrote in, not just by the app.
     *
     * Hydration bakes `FIREBASE_PROJECT_ID` into the repo's workflows. Promoting
     * an app to its own Firebase project changes that value, and a key on the
     * app id alone would short-circuit the re-run — leaving the promoted app's
     * CI deploying its rules to the *pool* project it no longer uses.
     */
    key: (s) => `github.hydrate:${s.appId}:${s.vars.FIREBASE_PROJECT_ID}`,

    /**
     * Always null — hydration is a commit, and asking "is it already done?"
     * would mean cloning the repo just to decide. Re-running is safe instead:
     * substitution is idempotent, so a second pass produces an identical tree
     * and `commitAndPush` returns null rather than an empty commit. The ledger
     * short-circuits it in the normal case anyway.
     */
    async read() {
      return null;
    },

    async create(spec) {
      const repo = await ctx.open(spec.fullName, ctx.branch);

      try {
        const paths = await repo.list();
        if (paths.length === 0) {
          throw new TerminalError(
            `${spec.fullName} is empty — the template repo (VON_TEMPLATE_REPO) has no content`,
          );
        }

        const source: Record<string, string> = {};
        for (const path of paths) {
          // Running a text substitution over image bytes corrupts them, and the
          // failure surfaces later as a build error about a malformed asset.
          if (isBinary(path)) continue;
          const contents = await repo.read(path);
          if (contents !== null) source[path] = contents;
        }

        // `generateRepo` rather than a bare `render` loop: it also applies the
        // DEFAULT_BRANCH convention and renders paths, so the substitution here
        // is the same one the generator's tests cover. Duplicating it is how the
        // two drift.
        const rendered = generateRepo(source, spec.vars);

        // Checked across the whole tree rather than per file, so the error names
        // every leak at once instead of one per re-run.
        assertNoUnresolvedTokens(rendered);

        let filesChanged = 0;
        for (const file of rendered) {
          // Only write what changed: most of a blueprint contains no tokens, and
          // a no-op write still dirties the file.
          if (source[file.path] === file.contents) continue;
          await repo.write(file.path, file.contents);
          filesChanged++;
        }

        const commitSha = await repo.commitAndPush(
          "Configure this app\n\nSubstitutes the blueprint's per-app values.\n\nvia Von",
        );
        return { commitSha, filesChanged };
      } finally {
        // The checkout holds a customer's repository on disk and the control
        // plane is long-lived.
        await repo.dispose();
      }
    },
  };
}
