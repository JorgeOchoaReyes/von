/**
 * Blueprint -> per-app repo.
 *
 * The blueprint is the ByteLearning stack with every app-specific value pulled
 * out into a `{{TOKEN}}`. Reading the reference implementation, these are the
 * values that were hardcoded and therefore had to become parameters:
 *
 *   apps/expo/app.json          extra.eas.projectId, name, slug, scheme, bundleIdentifier, package
 *   apps/expo/src/lib/firebase.ts  the whole firebaseConfig object (now fetched at runtime)
 *   .github/workflows/*.yml     FIREBASE_PROJECT, branch triggers
 *
 * Anything still hardcoded after generation is a per-app value that leaked, and
 * will eventually cause one tenant's app to talk to another tenant's backend.
 * `assertNoUnresolvedTokens` is the guard.
 */

/**
 * Production branch for every generated app.
 *
 * `master`, matching ByteLearning and this repo, so the branch a workflow
 * deploys from is the same name everywhere and there is no per-app branch
 * convention to remember. GitHub's "generate from template" copies the
 * template repo's default branch name, so the blueprint repo must also default
 * to `master` for generated repos to line up with the workflow triggers.
 */
export const PROD_BRANCH = "master";

// Indexed by `string | undefined` so a token lookup for a key the caller never
// supplied is expressible; `render` leaves those in place for
// `assertNoUnresolvedTokens` to catch rather than emitting "undefined".
export interface BlueprintVars extends Record<string, string | undefined> {
  APP_NAME: string;
  APP_SLUG: string;
  APP_ID: string;
  BUNDLE_ID: string;
  SCHEME: string;
  CHANNEL: string;
  /** Defaults to `PROD_BRANCH`; supply only to override the convention. */
  DEFAULT_BRANCH?: string;
  EAS_PROJECT_ID: string;
  FIREBASE_PROJECT_ID: string;
  /** Control-plane URL the app fetches its runtime config from. */
  VON_API_URL: string;
}

const TOKEN = /\{\{([A-Z_]+)\}\}/g;

export function render(template: string, vars: BlueprintVars): string {
  return template.replace(TOKEN, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match; // leave it; the assert below catches it
    return value;
  });
}

export interface GeneratedFile {
  path: string;
  contents: string;
}

export function generateRepo(
  blueprint: Record<string, string>,
  vars: BlueprintVars,
): GeneratedFile[] {
  // DEFAULT_BRANCH is a platform convention, not a per-app choice, so callers
  // do not have to supply it and cannot accidentally diverge from the branch
  // the generated workflows actually trigger on.
  //
  // Written as an explicit `??` rather than `{DEFAULT_BRANCH: PROD_BRANCH, ...vars}`:
  // spreading last overwrites the default with `undefined` when the caller omits
  // the key, which would emit an empty branch trigger and silently disable every
  // workflow in the generated repo.
  const resolved: BlueprintVars = {
    ...vars,
    DEFAULT_BRANCH: vars.DEFAULT_BRANCH ?? PROD_BRANCH,
  };
  return Object.entries(blueprint).map(([path, contents]) => ({
    path: render(path, resolved),
    contents: render(contents, resolved),
  }));
}

export interface UnresolvedToken {
  path: string;
  token: string;
  line: number;
}

/**
 * Fail the generation rather than push a repo with an unsubstituted token.
 *
 * A leftover `{{FIREBASE_PROJECT_ID}}` in a workflow is not a cosmetic bug: the
 * deploy would either fail loudly or, worse, target whatever project the literal
 * string happens to resolve to.
 */
export function assertNoUnresolvedTokens(files: GeneratedFile[]): void {
  const found: UnresolvedToken[] = [];

  for (const file of files) {
    file.contents.split("\n").forEach((line, i) => {
      for (const match of line.matchAll(TOKEN)) {
        found.push({ path: file.path, token: match[0], line: i + 1 });
      }
    });
  }

  if (found.length > 0) {
    const detail = found
      .slice(0, 10)
      .map((f) => `  ${f.path}:${f.line} ${f.token}`)
      .join("\n");
    throw new Error(
      `Blueprint has ${found.length} unresolved token(s):\n${detail}` +
        (found.length > 10 ? `\n  … and ${found.length - 10} more` : ""),
    );
  }
}
