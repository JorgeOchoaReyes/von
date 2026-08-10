import { cachingAuth, detectTokenSource } from "@von/provisioning";

/**
 * Does each credential actually work?
 *
 * Readiness answers a different question — is it *set* — and deliberately never
 * makes a network call, because a health check that spends money on every hit
 * is not a health check. That leaves a real gap on the day credentials are
 * added: every variable is present, readiness is all green, and the first thing
 * to discover that a token was pasted with a trailing newline or belongs to the
 * wrong Expo account is a background provisioning run, three steps in, with
 * half an app created.
 *
 * So this is the other half, run on demand. Every call here is **read-only** —
 * a whoami, a list, a token exchange. Nothing is created, so it is safe to run
 * against production as often as you like, and it costs nothing but latency.
 *
 * Each check reports what it *learned*, not just that it passed: the GitHub
 * login, the Google identity, the Expo account name. Half of what goes wrong on
 * the first real run is a credential that works perfectly and belongs to the
 * wrong account, which no boolean can show you.
 */

export interface Check {
  id: string;
  /** What this credential is for, in the same words readiness uses. */
  unlocks: string;
  status: "ok" | "failed" | "skipped";
  /** What it proved, when it worked: the account, the identity, the org. */
  detail: string;
}

export interface Preflight {
  ok: boolean;
  checks: Check[];
}

const skip = (id: string, unlocks: string, why: string): Check => ({
  id,
  unlocks,
  status: "skipped",
  detail: why,
});

/**
 * Read a response body for an error message without letting a huge or hostile
 * one into the log.
 */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `${res.status} ${text.slice(0, 200).replace(/\s+/g, " ").trim()}`.trim();
}

/**
 * Each check is wrapped so one provider being unreachable does not hide the
 * others. A network failure is a failed check, not a failed preflight run.
 */
async function attempt(
  id: string,
  unlocks: string,
  run: () => Promise<string>,
): Promise<Check> {
  try {
    return { id, unlocks, status: "ok", detail: await run() };
  } catch (err) {
    return { id, unlocks, status: "failed", detail: (err as Error).message };
  }
}

async function checkGitHub(): Promise<Check> {
  const token = process.env.GITHUB_INSTALLATION_TOKEN?.trim();
  const org = process.env.VON_GITHUB_ORG?.trim();
  const template = process.env.VON_TEMPLATE_REPO?.trim();

  if (!token) {
    return skip("github", "Creating repositories and dispatching releases", "no token set");
  }

  return attempt("github", "Creating repositories and dispatching releases", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    };

    const learned: string[] = [];

    // An installation token has no /user, so the identity comes from whichever
    // of these answers. Both being unavailable means the token is not valid for
    // anything this platform does.
    const me = await fetch("https://api.github.com/user", { headers });
    if (me.ok) {
      learned.push(`authenticated as ${((await me.json()) as { login: string }).login}`);
    } else {
      const inst = await fetch("https://api.github.com/installation/repositories?per_page=1", {
        headers,
      });
      if (!inst.ok) throw new Error(`token rejected: ${await reason(inst)}`);
      const body = (await inst.json()) as { total_count: number };
      learned.push(`installation token, ${body.total_count} repositories in scope`);
    }

    // The template repo is the one whose absence is silent until the first app
    // is created — and then genesis fails at the repo step having already made
    // a GCIP tenant and a database.
    if (template) {
      const res = await fetch(`https://api.github.com/repos/${template}`, { headers });
      if (!res.ok) throw new Error(`cannot read VON_TEMPLATE_REPO ${template}: ${await reason(res)}`);
      const repo = (await res.json()) as { is_template?: boolean; default_branch?: string };
      if (!repo.is_template) {
        throw new Error(`${template} is not marked as a template repository`);
      }
      if (repo.default_branch !== "master") {
        // Generate-from-template copies the template's default branch name, and
        // every generated workflow triggers on `master`. A template defaulting
        // to `main` produces apps whose CI never runs.
        throw new Error(
          `${template} defaults to "${repo.default_branch}"; it must default to "master"`,
        );
      }
      learned.push(`template ${template} ok`);
    }

    if (org) {
      const res = await fetch(`https://api.github.com/orgs/${org}`, { headers });
      learned.push(res.ok ? `org ${org} visible` : `org ${org} not readable (${res.status})`);
    }

    return learned.join("; ");
  });
}

async function checkGoogle(): Promise<Check> {
  const unlocks = "Provisioning an app's backend";

  // Detected before the check rather than inside it, so "nothing configured"
  // reads as skipped like every other provider. Reporting it as a failure made
  // a control plane running the two-token loop — a supported configuration —
  // answer 503 to its own preflight.
  const source = await detectTokenSource();
  if (!source) return skip("google", unlocks, "no Google credentials found");

  return attempt("google", unlocks, async () => {

    // The exchange itself is the check: a key with a malformed PEM, a revoked
    // service account, or a disabled IAM API all fail right here rather than
    // inside a provisioning step.
    const token = await cachingAuth(source).accessToken();

    const learned = [source.describe()];

    // Proves the token carries the scope provisioning needs, and that the
    // parent is one this identity can actually see — the most common cause of
    // "project creation failed" being a permission on the wrong folder.
    const parent = process.env.GCP_PARENT?.trim();
    if (parent) {
      const res = await fetch(
        `https://cloudresourcemanager.googleapis.com/v3/projects?parent=${encodeURIComponent(parent)}&pageSize=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`cannot list projects under ${parent}: ${await reason(res)}`);
      learned.push(`can list projects under ${parent}`);
    }

    const billing = process.env.GCP_BILLING_ACCOUNT?.trim();
    if (billing) {
      const res = await fetch(`https://cloudbilling.googleapis.com/v1/${billing}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`cannot read ${billing}: ${await reason(res)}`);
      const acct = (await res.json()) as { open?: boolean };
      if (!acct.open) throw new Error(`${billing} is closed; projects cannot be billed to it`);
      learned.push(`${billing} is open`);
    }

    return learned.join("; ");
  });
}

async function checkExpo(): Promise<Check> {
  const token = process.env.EXPO_TOKEN?.trim();
  const unlocks = "Creating EAS projects and update channels";
  if (!token) return skip("expo", unlocks, "no token set");

  return attempt("expo", unlocks, async () => {
    const res = await fetch("https://api.expo.dev/v2/auth/userInfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`token rejected: ${await reason(res)}`);

    const body = (await res.json()) as { data?: { username?: string } };
    const who = body.data?.username ?? "unknown";
    const expected = process.env.EXPO_ACCOUNT_NAME?.trim();

    // A token that works but belongs to a personal account rather than the
    // organisation is the failure that looks like success: projects get
    // created under the wrong owner, and nothing complains until someone goes
    // looking for an app that is not where they expected. So it fails here.
    if (expected && expected !== who) {
      throw new Error(`token belongs to ${who}, but EXPO_ACCOUNT_NAME is ${expected}`);
    }
    return `authenticated as ${who}`;
  });
}

async function checkAnthropic(): Promise<Check> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const unlocks = "Editing an app from a chat message";
  if (!key) return skip("agent", unlocks, "no key set");

  return attempt("agent", unlocks, async () => {
    // Listing models is the cheapest authenticated call, and it costs no tokens.
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`key rejected: ${await reason(res)}`);
    return "key accepted";
  });
}

async function checkMigrationBucket(): Promise<Check> {
  const bucket = process.env.VON_MIGRATION_BUCKET?.trim();
  const unlocks = "Copying an app's Firestore data on promotion";
  if (!bucket) return skip("migration", unlocks, "no bucket set");

  return attempt("migration", unlocks, async () => {
    const source = await detectTokenSource();
    // A failure, unlike the case above: a bucket was named, so someone meant
    // for this to work.
    if (!source) throw new Error("bucket is set but there are no Google credentials to reach it");

    const token = await cachingAuth(source).accessToken();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`cannot read bucket ${bucket}: ${await reason(res)}`);
    return `bucket ${bucket} readable`;
  });
}

async function checkPlay(): Promise<Check> {
  const key = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT?.trim();
  const unlocks = "Submitting to Google Play's internal track";
  if (!key) return skip("play", unlocks, "no service account set");

  return attempt("play", unlocks, async () => {
    // Only the shape is checked. Play's API is per-app — every meaningful call
    // needs a package name that exists in the console — so there is nothing
    // useful to ask it before the first listing exists.
    const parsed = JSON.parse(key) as { client_email?: string; type?: string };
    if (parsed.type !== "service_account" || !parsed.client_email) {
      throw new Error("not a service account key");
    }
    return `${parsed.client_email} (shape only — Play cannot be checked before a listing exists)`;
  });
}

/**
 * Run every check that has something to check.
 *
 * Concurrent because they are independent and each is a round trip to a
 * different provider; serially this is the slowest possible way to learn six
 * unrelated facts.
 */
export async function preflight(): Promise<Preflight> {
  const checks = await Promise.all([
    checkAnthropic(),
    checkGitHub(),
    checkGoogle(),
    checkExpo(),
    checkMigrationBucket(),
    checkPlay(),
  ]);

  // Skipped is not failed. A deployment that has deliberately not configured
  // Play is not broken, and reporting it as such would train everyone to
  // ignore this.
  return { ok: checks.every((c) => c.status !== "failed"), checks };
}
