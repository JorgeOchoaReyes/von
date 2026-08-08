import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { classifyChange, type ReleaseDecision } from "@von/release";
import { diffDependencies, type Workspace } from "./workspace.ts";

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

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncGenerator<AgentEvent, void, unknown> {
  const client = opts.client ?? new Anthropic();
  const ws = opts.workspace;
  const pkgBefore = await ws.read("apps/expo/package.json");

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
