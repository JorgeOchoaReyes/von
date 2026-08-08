import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { classifyChange, type ReleaseDecision } from "@von/release";
import {
  diffDependencies,
  isProtected,
  protectedPaths,
  type Workspace,
} from "./workspace.ts";

/**
 * The build agent.
 *
 * It edits the generated app's repo through a small, deliberately shaped tool
 * surface. Each tool exists because the harness needs to *intercept* that
 * action — gate it, render it, or feed it into the release decision — which is
 * exactly the criterion for promoting an action out of a general-purpose
 * "run a command" tool.
 */

export interface AgentEvent {
  type: "text" | "tool" | "done" | "error";
  text?: string;
  tool?: { name: string; summary: string };
  decision?: ReleaseDecision;
}

export interface RunAgentOptions {
  workspace: Workspace;
  /** Prior conversation, oldest first. */
  history?: Anthropic.Beta.BetaMessageParam[];
  message: string;
  /** Describes the app being edited; goes in the cached prefix. */
  appSummary: string;
  /**
   * Pooled apps share their rules and functions with every other pooled app,
   * so those files are not theirs to edit. See `protectedPaths`.
   */
  backendTier: "pooled" | "dedicated";
  client?: Anthropic;
  signal?: AbortSignal;
}

const MODEL = "claude-opus-5";

/**
 * The stable half of the system prompt. Kept byte-identical across every turn
 * and every app so it stays a cache prefix — the per-app summary goes after it,
 * and the user's message after that.
 */
const SYSTEM_CORE = `You build and edit mobile apps for a user who is describing what they want in chat. They are not necessarily a developer.

The app is an Expo (SDK 52, expo-router) + Firebase monorepo:
- apps/expo/app/**        expo-router screens (file-based routes)
- apps/expo/src/**        components, hooks, client libraries
- packages/firebase/**    shared Firestore helpers and data-model types
- functions/**            Cloud Functions v2 (callable + Firestore triggers)
- firestore.rules         security rules

How your changes reach the user's phone:
- Editing screens, components, packages, or assets ships over the air in about a minute.
- Editing app.json, eas.json, native directories, or adding a dependency with native code needs a new binary build, which takes about ten minutes and requires the user to install it.
- Editing functions/ or firestore.rules deploys through CI and does not touch the app bundle.

Prefer changes that ship over the air. If a request can be satisfied without a new dependency or a native config change, do it that way and say so. If it genuinely needs a native build, make the change and explain the tradeoff in one sentence — do not ask for permission first.

Write code that matches the surrounding file: same import style, same naming, same comment density. Read a file before editing it. Make the whole change, including the Firestore rules and types it implies — a screen that reads a new collection needs that collection's rules and types too.

Keep your replies to the user short and concrete. Say what you changed and what they will see. Do not narrate your file operations, restate the request, or list every file you touched.`;

/**
 * Tier-specific half of the system prompt. Two fixed strings rather than an
 * interpolated one, so both stay cacheable across every app on that tier.
 */
const TIER_NOTES: Record<"pooled" | "dedicated", string> = {
  pooled: `This app runs on a shared backend. It has its own isolated users and its own private data, but the security rules and the Cloud Functions are shared with other apps and are not part of this repo — you cannot edit firestore.rules, firebase.json, or anything under functions/.

Almost everything can still be built: screens, navigation, state, styling, and reading and writing the app's own data all work normally. Data lives under the app's own tenant prefix, which the client library handles for you.

If a request genuinely needs custom server-side code, a scheduled job, a database trigger, or custom security rules, do not try to work around it. Say plainly that it needs the app's own backend, describe in one sentence what that gives them, and offer to set it up.`,

  dedicated: `This app has its own backend: its own database, its own authentication, and its own Cloud Functions deployed from this repo. firestore.rules and functions/ are yours to edit.

When you add a screen that reads or writes a new collection, add the matching security rules in the same change. A screen shipped without rules either fails at runtime or, worse, leaves data readable by anyone signed in.`,
};

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncGenerator<AgentEvent, void, unknown> {
  const client = opts.client ?? new Anthropic();
  const ws = opts.workspace;
  const pkgBefore = await ws.read("apps/expo/package.json");
  const locked = protectedPaths(opts.backendTier);

  /**
   * Enforced here rather than only in the prompt. The system prompt tells the
   * model these files are shared, but a prompt is guidance and this is a
   * cross-tenant security boundary — it needs a check the model cannot talk
   * its way past.
   */
  const guard = (path: string): string | null =>
    isProtected(path, locked)
      ? `error: ${path} is shared with every other app on this backend and cannot be edited here. ` +
        `Solve this within the app's own code, or tell the user this needs their own backend ` +
        `(their own database, functions and rules), which you can offer to set up.`
      : null;

  const listFiles = betaZodTool({
    name: "list_files",
    description:
      "List repository file paths, optionally filtered by a path prefix such as 'apps/expo/app/'. Use this first when you are unsure where something lives.",
    inputSchema: z.object({
      prefix: z.string().default("").describe("Path prefix to filter by."),
    }),
    run: async ({ prefix }) => (await ws.list(prefix)).join("\n") || "(no matching files)",
  });

  const readFile = betaZodTool({
    name: "read_file",
    description:
      "Read a file's full contents. Always read a file before editing it so your replacement matches what is actually there.",
    inputSchema: z.object({ path: z.string() }),
    run: async ({ path }) => (await ws.read(path)) ?? `(no file at ${path})`,
  });

  const writeFile = betaZodTool({
    name: "write_file",
    description:
      "Create a file, or replace one entirely. For a small change to a large file prefer edit_file, which is cheaper and less likely to drop surrounding code.",
    inputSchema: z.object({ path: z.string(), contents: z.string() }),
    run: async ({ path, contents }) => {
      const denied = guard(path);
      if (denied) return denied;
      await ws.write(path, contents);
      return `wrote ${path} (${contents.split("\n").length} lines)`;
    },
  });

  const editFile = betaZodTool({
    name: "edit_file",
    description:
      "Replace an exact string in a file. The old_text must appear exactly once; if it does not, read the file and retry with more surrounding context.",
    inputSchema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    run: async ({ path, old_text, new_text }) => {
      const denied = guard(path);
      if (denied) return denied;
      const current = await ws.read(path);
      if (current === null) return `error: no file at ${path}`;
      const count = current.split(old_text).length - 1;
      if (count === 0) return `error: old_text not found in ${path}`;
      if (count > 1) return `error: old_text appears ${count} times in ${path}; add more context`;
      await ws.write(path, current.replace(old_text, new_text));
      return `edited ${path}`;
    },
  });

  const tools = [listFiles, readFile, writeFile, editFile];

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.message },
  ];

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [
      // Cached prefix: identical for every request the platform ever makes.
      { type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } },
      // One of two fixed strings, so it also caches across apps.
      { type: "text", text: TIER_NOTES[opts.backendTier], cache_control: { type: "ephemeral" } },
      // Per-app, stable across a session — cached separately.
      { type: "text", text: opts.appSummary, cache_control: { type: "ephemeral" } },
    ],
    messages,
    tools,
    stream: true,
  });

  try {
    for await (const stream of runner) {
      for await (const event of stream) {
        if (opts.signal?.aborted) return;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          yield {
            type: "tool",
            tool: { name: event.content_block.name, summary: "" },
          };
        }
      }

      const message = await stream.finalMessage();
      // A server-tool turn can pause; the runner does not auto-resume it.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }
  } catch (err) {
    yield { type: "error", text: (err as Error).message };
    return;
  }

  // Hand the exact change set to the release classifier. This is why the
  // workspace records touched paths rather than us diffing a working tree.
  const pkgAfter = await ws.read("apps/expo/package.json");
  const deps = diffDependencies(pkgBefore, pkgAfter);
  const decision = classifyChange({
    files: ws.changedFiles(),
    addedDependencies: deps.added,
    removedDependencies: deps.removed,
  });

  yield { type: "done", decision };
}
