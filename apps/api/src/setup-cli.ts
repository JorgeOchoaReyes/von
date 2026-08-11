import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkReadiness } from "./readiness.ts";
import { preflight, type Check } from "./preflight.ts";

/**
 * Setting the platform up, one stage at a time.
 *
 * The alternative this replaces is a list in a document: twenty variables, no
 * order, no way to tell which ones you can stop after, and no feedback until
 * something fails hours later inside a background task. Reading that list, the
 * only honest question — *have I done enough to try this yet?* — has no answer.
 *
 * So this asks for one stage at a time, and after each one it **checks with the
 * provider** rather than declaring success. A stage ends by telling you what
 * now works and what the next stage would add, which means stopping after any
 * of them is a decision rather than an accident.
 *
 * Three things it deliberately does not do:
 *
 *   - **Create anything.** Every check is read-only. A setup tool that
 *     provisions while you are still deciding what to configure is a tool you
 *     cannot run twice.
 *   - **Print a secret back.** Values already set are shown masked. The point
 *     of the display is "something is here", not "here it is".
 *   - **Guess.** A blank answer keeps whatever is already there. Re-running
 *     after fixing one variable should not mean retyping the other nineteen.
 *
 *     pnpm configure             walk the stages
 *     pnpm configure --check     verify what is configured, no prompts, no writes
 *     pnpm configure --stage 2   one stage
 */

const ENV_PATH = resolve(process.cwd(), "../../.env");

interface Var {
  name: string;
  /** One line: what it is. */
  label: string;
  /** Where to get it, or what it has to be. Printed above the prompt. */
  help?: string;
  /** Masked when shown, never echoed back in full. */
  secret?: boolean;
  /**
   * Other variables that satisfy the same requirement. Prompting for a Google
   * key when `GOOGLE_APPLICATION_CREDENTIALS` is already set is noise.
   */
  alternatives?: string[];
  /** Offered as the answer when the value is unset and Enter is pressed. */
  suggestion?: string;
  /** A file path here is read and its contents stored — service account keys. */
  acceptsPath?: boolean;
  optional?: boolean;
}

interface Stage {
  n: number;
  title: string;
  /** What this stage buys you, and what not doing it costs. */
  why: string;
  vars: Var[];
  /** Preflight checks worth running once this stage is filled in. */
  verify: string[];
  /** What you can do after finishing it. */
  unlocks: string;
  /** Work that is not a variable — printed as instructions, not prompted for. */
  manual?: string[];
}

const STAGES: Stage[] = [
  {
    n: 1,
    title: "The product loop",
    why:
      "Two credentials, and the whole loop runs: describe an app in chat, watch a\n" +
      "preview, publish a change. No billing account, no Expo organisation, no DNS.\n" +
      "Create an app with a repoFullName you already own and provisioning is skipped\n" +
      "entirely — this is the fastest way to see whether the product works.",
    vars: [
      {
        name: "ANTHROPIC_API_KEY",
        label: "Anthropic API key — the agent that edits an app's code",
        help: "console.anthropic.com -> API keys",
        secret: true,
      },
      {
        name: "GITHUB_INSTALLATION_TOKEN",
        label: "GitHub token — cloning, pushing, dispatching workflows",
        help:
          "A PAT with repo scope works to try this. An App installation token is\n" +
          "     what you want in a deployment; it is scoped to the repos you install it on.",
        secret: true,
      },
    ],
    verify: ["agent", "github"],
    unlocks:
      "Start the control plane and create an app against a repo you already own:\n\n" +
      '  curl -X POST localhost:8787/v1/apps -H \'content-type: application/json\' \\\n' +
      '    -d \'{"name":"Trail Notes","repoFullName":"you/your-expo-app"}\'',
  },
  {
    n: 2,
    title: "Provisioning an app from nothing",
    why:
      "Creating an app's repository, backend and EAS project without an existing repo\n" +
      "to adopt. This is where real money starts being spent — a GCP project per pool,\n" +
      "and an EAS project per app.",
    manual: [
      "Push templates/app-blueprint/ to a repository of its own.",
      'Set that repository\'s default branch to "master". Generate-from-template',
      "  copies the template's branch name, and every generated workflow triggers on",
      "  master — a template defaulting to main produces apps whose CI never runs.",
      "Mark it a template: Settings -> check 'Template repository'.",
    ],
    vars: [
      {
        name: "VON_GITHUB_ORG",
        label: "GitHub org that generated app repositories are created in",
        help: "Your own username works while trying this.",
      },
      {
        name: "VON_TEMPLATE_REPO",
        label: "The blueprint repository, as owner/repo",
        help: "The one from the steps above. Checked below — template flag and branch.",
      },
      {
        name: "VON_PUBLIC_URL",
        label: "Where generated apps fetch their backend config at boot",
        help:
          "Baked into every app that is created. Wrong here is not a startup failure —\n" +
          "     it is an app on someone's phone that cannot reach its own backend.",
        suggestion: "http://localhost:8787",
      },
      {
        name: "GOOGLE_SERVICE_ACCOUNT_KEY",
        label: "Google service account key (paste the JSON, or give a path to it)",
        help:
          "gcloud iam service-accounts keys create von-runtime.json --iam-account ...\n" +
          "     Needs resourcemanager.projectCreator and billing.user on the folder that\n" +
          "     holds pool projects. On Cloud Run, leave blank — the metadata server\n" +
          "     supplies the identity and there is no key to store or rotate.",
        secret: true,
        acceptsPath: true,
        alternatives: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_ACCESS_TOKEN"],
      },
      {
        name: "GCP_PARENT",
        label: "Folder or org new pool projects are created under",
        help: "folders/123456789012 or organizations/123456789012",
      },
      {
        name: "GCP_BILLING_ACCOUNT",
        label: "Billing account attached to pool projects",
        help: "billingAccounts/00X000-000000-000000 — checked below that it is open",
      },
      {
        name: "VON_POOLS",
        label: "Pool projects, as a JSON array",
        help: '["von-pool-001"] — a pooled app gets its own tenant and database inside one',
        suggestion: "[]",
      },
      {
        name: "VON_POOL_WEB_CONFIGS",
        label: "Each pool project's Firebase web config, as JSON",
        help: '{"von-pool-001":{"apiKey":"...","projectId":"von-pool-001", ...}}',
        suggestion: "{}",
      },
      {
        name: "EXPO_TOKEN",
        label: "Expo access token — EAS projects, channels, builds",
        help: "expo.dev -> account settings -> access tokens. Also written into each repo.",
        secret: true,
      },
      { name: "EXPO_ACCOUNT_ID", label: "Expo account id" },
      {
        name: "EXPO_ACCOUNT_NAME",
        label: "Expo account name",
        help: "Checked below against the token — a token for a personal account creates\n     projects under the wrong owner and nothing else notices.",
      },
      {
        name: "GEMINI_API_KEY",
        label: "Gemini key handed to each generated app's Cloud Functions",
        optional: true,
      },
    ],
    verify: ["github", "google", "expo"],
    unlocks:
      "Create an app with no repoFullName. Genesis runs for real: GCIP tenant,\n" +
      "Firestore database, repository, EAS project, hydration, secrets.",
  },
  {
    n: 3,
    title: "Running it as a deployment",
    why:
      "Without these the control plane works but forgets: apps, the resource ledger\n" +
      "and pool assignments live in memory, so a restart loses them and a re-run of\n" +
      "provisioning creates duplicate cloud resources instead of resuming.",
    vars: [
      {
        name: "VON_FIRESTORE_PROJECT",
        label: "Project holding the control plane's own Firestore",
        help: "Not a pool project — this is Von's own storage.",
      },
      {
        name: "VON_FIRESTORE_DATABASE",
        label: "Database name inside it",
        suggestion: "von-control",
      },
      {
        name: "VON_API_KEYS",
        label: "Comma-separated API keys callers must present",
        help:
          "Not optional once deployed. Every endpoint creates billable resources, and\n" +
          "     the control plane refuses to start without this as soon as storage or a\n" +
          "     preview host is set. Generate one: openssl rand -hex 32",
        secret: true,
      },
      {
        name: "VON_PREVIEW_HOST",
        label: "Wildcard host previews are served under",
        help:
          "preview.example.com, with *.preview.example.com resolving to the control\n" +
          "     plane. Unset, previews work only on the machine running it.",
        optional: true,
      },
    ],
    verify: [],
    unlocks: "Apps survive a restart, and the control plane refuses anonymous callers.",
  },
  {
    n: 4,
    title: "Optional capabilities",
    why: "Neither is needed to run the platform. Each turns on one specific thing.",
    vars: [
      {
        name: "VON_MIGRATION_BUCKET",
        label: "GCS bucket where a promotion stages its Firestore export",
        help:
          "Promotion works without it, but only by accepting that the app starts\n" +
          "     against an empty database and its users' documents stay in the pool.",
        optional: true,
      },
      {
        name: "GOOGLE_PLAY_SERVICE_ACCOUNT",
        label: "Play Developer API service account key (JSON, or a path)",
        help:
          "Play still needs a listing created by hand with the app's package name,\n" +
          "     and one bundle uploaded through its console before it accepts any\n" +
          "     through the API.",
        secret: true,
        acceptsPath: true,
        optional: true,
      },
    ],
    verify: ["migration", "play"],
    unlocks: "Promotion can carry an app's data; apps can reach Play's internal track.",
  },
];

// ── .env round-tripping ──────────────────────────────────────────────────────

/**
 * Parse just enough dotenv to round-trip our own file.
 *
 * Values are written single-quoted, so parsing has to unwrap those. Anything
 * the file already contains that this tool does not manage is preserved —
 * clobbering a variable someone added by hand would be the fastest way to make
 * this untrustworthy.
 */
function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    ) {
      value = value.slice(1, -1).replace(/\\'/g, "'");
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Single quotes, because a service account key contains characters a shell
 * would otherwise interpret, and because `set -a && . ./.env` is how this file
 * is meant to be loaded.
 */
const quote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

function renderEnv(values: Map<string, string>): string {
  const managed = new Set(STAGES.flatMap((s) => s.vars.map((v) => v.name)));
  const lines = [
    "# Von — written by `pnpm configure`. Load it with:",
    "#   set -a && . ./.env && set +a",
    "",
  ];

  for (const stage of STAGES) {
    const present = stage.vars.filter((v) => values.get(v.name));
    if (present.length === 0) continue;
    lines.push(`# ── ${stage.n}. ${stage.title} ${"─".repeat(Math.max(0, 50 - stage.title.length))}`);
    for (const v of present) lines.push(`${v.name}=${quote(values.get(v.name)!)}`);
    lines.push("");
  }

  // Kept rather than dropped: this file is the user's, not this tool's.
  const extra = [...values].filter(([k, v]) => !managed.has(k) && v);
  if (extra.length > 0) {
    lines.push("# ── Not managed by `pnpm configure` ──────────────────────────");
    for (const [k, v] of extra) lines.push(`${k}=${quote(v)}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── presentation ─────────────────────────────────────────────────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

/**
 * Enough to confirm the right value is there, not enough to leak it over a
 * shoulder or into a screen recording.
 */
const mask = (v: string): string =>
  v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}${"•".repeat(6)}${v.slice(-4)}`;

function printCheck(check: Check): void {
  const mark =
    check.status === "ok" ? c.green("ok  ") : check.status === "failed" ? c.red("fail") : c.dim("--  ");
  console.log(`  ${mark} ${check.id.padEnd(10)} ${check.detail}`);
}

/** Run the provider checks a stage cares about, against what is now in env. */
async function verify(stage: Stage): Promise<boolean> {
  if (stage.verify.length === 0) return true;

  console.log(`\n${c.bold("Checking with the providers")} ${c.dim("(read-only)")}`);
  const { checks } = await preflight();
  const mine = checks.filter((ch) => stage.verify.includes(ch.id));
  mine.forEach(printCheck);

  const failed = mine.filter((ch) => ch.status === "failed");
  if (failed.length > 0) {
    console.log(
      c.yellow(
        `\n  ${failed.length} check${failed.length === 1 ? "" : "s"} failed. The values are saved — ` +
          `fix and re-run\n  \`pnpm configure --stage ${stage.n}\`, or press on and come back to it.`,
      ),
    );
  }
  return failed.length === 0;
}

// ── the walkthrough ──────────────────────────────────────────────────────────

async function runStage(
  stage: Stage,
  values: Map<string, string>,
  ask: (q: string) => Promise<string>,
): Promise<void> {
  console.log(`\n${c.bold(`── Stage ${stage.n}: ${stage.title} `.padEnd(70, "─"))}\n`);
  console.log(`${stage.why}\n`);

  if (stage.manual) {
    console.log(c.bold("First, by hand:"));
    for (const [i, step] of stage.manual.entries()) {
      console.log(`  ${step.startsWith(" ") ? "  " : `${i + 1}. `}${step}`);
    }
    await ask(c.dim("\n  Press Enter when that is done (or to skip past it) "));
  }

  for (const v of stage.vars) {
    const current = values.get(v.name) ?? "";

    // An alternative already answers this requirement; asking again would
    // suggest both are needed.
    const satisfiedBy = v.alternatives?.find((alt) => values.get(alt));
    if (!current && satisfiedBy) {
      console.log(`\n${c.bold(v.name)}\n  ${c.dim(`satisfied by ${satisfiedBy} — skipping`)}`);
      continue;
    }

    console.log(`\n${c.bold(v.name)}${v.optional ? c.dim("  (optional)") : ""}`);
    console.log(`  ${v.label}`);
    if (v.help) console.log(c.dim(`     ${v.help}`));
    if (current) console.log(`  ${c.dim("currently:")} ${v.secret ? mask(current) : current}`);

    const hint = current
      ? "Enter to keep"
      : v.suggestion
        ? `Enter for ${v.suggestion}`
        : v.optional
          ? "Enter to skip"
          : "Enter to leave unset";

    const answer = (await ask(`  > ${c.dim(`[${hint}] `)}`)).trim();

    if (!answer) {
      if (!current && v.suggestion) values.set(v.name, v.suggestion);
      continue;
    }

    // A path is far easier to paste correctly than a multi-line PEM, and it is
    // the shape `gcloud ... keys create` leaves you holding.
    if (v.acceptsPath && !answer.startsWith("{") && existsSync(answer)) {
      values.set(v.name, await readFile(answer, "utf8"));
      console.log(c.dim(`  read ${answer}`));
      continue;
    }

    values.set(v.name, answer);
  }

  // Applied to this process so the checks below see them without a restart.
  for (const [k, val] of values) if (val) process.env[k] = val;

  await writeFile(ENV_PATH, renderEnv(values));
  console.log(c.dim(`\n  saved to ${ENV_PATH}`));

  await verify(stage);

  console.log(`\n${c.bold("This gets you:")}\n${stage.unlocks}\n`);
}

/** Non-interactive: what is configured, and does it work. */
async function check(): Promise<number> {
  const readiness = checkReadiness();

  console.log(c.bold("\nConfigured\n"));
  for (const cap of readiness.capabilities) {
    const mark = cap.ready ? c.green("ok  ") : c.dim("--  ");
    const missing = cap.missing.length > 0 ? c.dim(`missing ${cap.missing.join(", ")}`) : "";
    console.log(`  ${mark} ${cap.id.padEnd(10)} ${cap.unlocks}`);
    if (missing) console.log(`       ${missing}`);
  }

  console.log(c.bold("\nAccepted by the provider\n"));
  const result = await preflight();
  result.checks.forEach(printCheck);

  const failed = result.checks.filter((ch) => ch.status === "failed");
  console.log(
    failed.length === 0
      ? c.green("\nNothing is failing.\n")
      : c.red(`\n${failed.length} check${failed.length === 1 ? "" : "s"} failing.\n`),
  );
  return failed.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Loaded before anything else so `--check` reports on the file rather than
  // on whatever happens to be exported in this shell.
  const values = existsSync(ENV_PATH)
    ? parseEnv(await readFile(ENV_PATH, "utf8"))
    : new Map<string, string>();
  for (const [k, v] of values) if (v && !process.env[k]) process.env[k] = v;

  if (args.includes("--check")) {
    process.exitCode = await check();
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      "This walkthrough needs a terminal. For a non-interactive report, run:\n" +
        "  pnpm configure --check",
    );
    process.exitCode = 2;
    return;
  }

  const only = args.indexOf("--stage");
  const wanted = only >= 0 ? Number(args[only + 1]) : null;
  const stages = wanted ? STAGES.filter((s) => s.n === wanted) : STAGES;

  if (stages.length === 0) {
    console.error(`No stage ${wanted}. Stages are 1-${STAGES.length}.`);
    process.exitCode = 2;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * Ctrl+C and Ctrl+D are answers too.
   *
   * `readline`'s promise rejects with an AbortError, and unhandled that is a
   * Node stack trace across the screen — after which everything typed so far is
   * gone, because the file is only written at the end of a stage. Leaving on
   * purpose should not cost you the four values you had already entered, so
   * this saves and exits quietly.
   */
  class Aborted extends Error {}
  const ask = async (q: string): Promise<string> => {
    try {
      return await rl.question(q);
    } catch {
      throw new Aborted();
    }
  };

  console.log(c.bold("\nVon setup"));
  console.log(
    "\nOne stage at a time, each one usable on its own. Blank keeps what is already\n" +
      "there, so re-running after a fix does not mean retyping everything. Nothing\n" +
      "here creates any cloud resource — every check is read-only.\n" +
      `\nValues are written to ${ENV_PATH}.`,
  );

  try {
    for (const stage of stages) {
      await runStage(stage, values, ask);
      if (stage !== stages[stages.length - 1]) {
        const next = (await ask(c.dim("  Continue to the next stage? [Y/n] "))).trim().toLowerCase();
        if (next === "n" || next === "no") break;
      }
    }
  } catch (err) {
    if (!(err instanceof Aborted)) throw err;
    await writeFile(ENV_PATH, renderEnv(values));
    console.log(c.dim(`\n\nStopped. What you entered is in ${ENV_PATH}.`));
    console.log(c.dim("Pick up where you left off with `pnpm configure`.\n"));
    rl.close();
    return;
  } finally {
    rl.close();
  }

  console.log(c.bold("Next\n"));
  console.log("  set -a && . ./.env && set +a");
  console.log("  pnpm --filter @von/api dev");
  console.log("  curl -s localhost:8787/v1/preflight | jq\n");
  console.log(c.dim("Re-run any time: pnpm configure, or pnpm configure --check for a report.\n"));
}

await main();
