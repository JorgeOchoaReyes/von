/**
 * What this control plane can actually do, given the credentials it has.
 *
 * Credentials arrive in stages — a GitHub token before a billing account,
 * Expo before wildcard DNS — and until now the only way to discover a gap was
 * to trigger the work and read a stack trace from a background task. That is a
 * bad way to learn that `GCP_PARENT` is unset.
 *
 * So capabilities are declared, not inferred: each one names the variables it
 * needs and what is unavailable without them. The answer is a checklist you can
 * fetch, not an error you have to provoke.
 *
 * It checks *presence and shape*, never validity. A syntactically perfect token
 * that the provider rejects still fails at the provider — proving otherwise
 * would mean spending money on every health check.
 */

export interface Capability {
  id: string;
  /** What having this unlocks, in the user's terms. */
  unlocks: string;
  required: string[];
  /** Present but unusable — malformed JSON, a bad `owner/repo`. */
  invalid?: string[];
  missing: string[];
  ready: boolean;
}

export interface Readiness {
  /** Everything needed for the full create-an-app loop is present. */
  ready: boolean;
  capabilities: Capability[];
  /** One line per gap, ordered so the first is the one to fix next. */
  blockers: string[];
}

const present = (name: string): boolean => Boolean(process.env[name]?.trim());

/** JSON-valued variables: set-but-unparseable is worse than unset, because it
 * looks configured right up until the moment it is needed. */
function invalidJson(name: string, expect: "array" | "object"): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return expect === "array" ? !Array.isArray(parsed) : typeof parsed !== "object";
  } catch {
    return true;
  }
}

/**
 * A requirement one of several variables can satisfy.
 *
 * Google credentials come in three shapes and any one of them works, so
 * listing all three as required would report a fully working control plane as
 * broken. Rendered as `A|B|C` in `missing`, which reads as the choice it is.
 */
const anyOf = (...names: string[]): string => names.join("|");

const satisfied = (requirement: string): boolean =>
  requirement.split("|").some((name) => present(name));

function capability(
  id: string,
  unlocks: string,
  required: string[],
  invalid: string[] = [],
): Capability {
  const missing = required.filter((name) => !satisfied(name));
  return {
    id,
    unlocks,
    required,
    ...(invalid.length ? { invalid } : {}),
    missing,
    ready: missing.length === 0 && invalid.length === 0,
  };
}

export function checkReadiness(): Readiness {
  const capabilities: Capability[] = [
    capability("storage", "Durable apps, resource ledger and pool assignments", [
      "VON_FIRESTORE_PROJECT",
    ]),

    capability("auth", "Rejecting callers without an API key", ["VON_API_KEYS"]),

    capability("agent", "Editing an app from a chat message", ["ANTHROPIC_API_KEY"]),

    capability("github", "Creating an app's repository and dispatching releases", [
      "GITHUB_INSTALLATION_TOKEN",
      "VON_GITHUB_ORG",
      "VON_TEMPLATE_REPO",
    ]),

    // Baked into every generated app as the address it fetches its backend
    // config from at boot. A wrong value here is not a startup failure — it is
    // an app shipped to a phone that cannot reach its own backend.
    capability("publicUrl", "Generated apps knowing where to fetch their config", [
      "VON_PUBLIC_URL",
    ]),

    capability(
      "google",
      "Provisioning an app's backend — GCIP tenant and Firestore database",
      [
        // Any one of these three. On Cloud Run none of them is set and the
        // metadata server supplies the identity — which cannot be detected
        // from the environment, so that case reports as missing here and works
        // anyway. Erring toward a false warning rather than a false all-clear.
        anyOf(
          "GOOGLE_SERVICE_ACCOUNT_KEY",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "GOOGLE_ACCESS_TOKEN",
        ),
        "GCP_PARENT",
        "GCP_BILLING_ACCOUNT",
        "VON_POOLS",
        "VON_POOL_WEB_CONFIGS",
      ],
      [
        ...(invalidJson("VON_POOLS", "array") ? ["VON_POOLS is not a JSON array"] : []),
        ...(invalidJson("VON_POOL_WEB_CONFIGS", "object")
          ? ["VON_POOL_WEB_CONFIGS is not a JSON object"]
          : []),
      ],
    ),

    capability("expo", "Creating the app's EAS project and update channel", [
      "EXPO_TOKEN",
      "EXPO_ACCOUNT_ID",
      "EXPO_ACCOUNT_NAME",
    ]),

    capability("previews", "Reaching a preview from a phone rather than only locally", [
      "VON_PREVIEW_HOST",
    ]),

    capability("functions", "Handing generated apps a key for their Cloud Functions", [
      "GEMINI_API_KEY",
    ]),

    // Promotion works without it — the caller has to accept a data reset —
    // but "your documents can come with you" is off the table until a bucket
    // exists, and discovering that mid-promotion is the wrong time.
    capability("migration", "Copying an app's Firestore data when it is promoted", [
      "VON_MIGRATION_BUCKET",
    ]),
  ];

  const blockers = capabilities
    .filter((c) => !c.ready)
    .map((c) => {
      const problems = [...(c.invalid ?? []), ...c.missing.map((m) => `${m} unset`)];
      return `${c.id}: ${problems.join(", ")} — without it, ${lower(c.unlocks)} is unavailable`;
    });

  return { ready: blockers.length === 0, capabilities, blockers };
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The subset needed to exercise the product loop against a repository that
 * already exists — chat, agent edit, preview, publish.
 *
 * Called out separately because it is by far the cheapest useful milestone: two
 * tokens, no billing account, no Expo org, no DNS. Everything `google` and
 * `expo` unlock is about *creating* an app's infrastructure, which an adopted
 * repository already has.
 */
export function adoptedRepoReadiness(): { ready: boolean; missing: string[] } {
  const needed = ["ANTHROPIC_API_KEY", "GITHUB_INSTALLATION_TOKEN"];
  const missing = needed.filter((n) => !present(n));
  return { ready: missing.length === 0, missing };
}

/** Startup summary. A control plane that cannot do the thing you are about to
 * ask it to do should say so before you ask, not while failing. */
export function logReadiness(): void {
  const { ready, capabilities, blockers } = checkReadiness();

  for (const c of capabilities) {
    console.log(`[readiness] ${c.ready ? "ok  " : "MISS"} ${c.id.padEnd(9)} ${c.unlocks}`);
  }

  if (ready) {
    console.log("[readiness] fully configured");
    return;
  }

  for (const b of blockers) console.warn(`[readiness] ${b}`);

  const adopted = adoptedRepoReadiness();
  if (adopted.ready) {
    console.log(
      "[readiness] the chat -> preview -> publish loop is usable now: " +
        "create an app with an existing repoFullName to skip provisioning.",
    );
  }
}
