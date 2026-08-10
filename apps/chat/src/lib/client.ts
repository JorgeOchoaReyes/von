import Constants from "expo-constants";

export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  process.env.EXPO_PUBLIC_VON_API_URL ??
  "http://localhost:8787";

/**
 * The client's key for the control plane.
 *
 * Every call below creates or changes something billable, and the control plane
 * rejects unauthenticated callers once deployed — so without this the app 401s
 * on its first message.
 *
 * It ships inside the bundle, which means it is **not secret**: anyone with the
 * app can read it. That is acceptable only because it is a distinct key from
 * the console's, revocable on its own, and because `VON_API_KEYS` accepts a
 * list precisely so this one can be rotated without downtime. Replacing it with
 * a per-user token is what a real multi-tenant boundary needs; until then, do
 * not reuse the console's key here.
 *
 * Empty in local development, where the control plane runs open.
 */
const API_KEY: string =
  (Constants.expoConfig?.extra as { apiKey?: string } | undefined)?.apiKey ??
  process.env.EXPO_PUBLIC_VON_API_KEY ??
  "";

const authHeaders = (): Record<string, string> =>
  API_KEY ? { authorization: `Bearer ${API_KEY}` } : {};

export interface ReleaseInfo {
  kind: "ota" | "native" | "none";
  reason: string;
  commit?: string | null;
}

/** What a turn produced: something to look at, and what shipping it would cost. */
export interface PreviewInfo {
  url: string | null;
  error?: string;
  kind: "ota" | "native" | "none";
  reason: string;
  files: string[];
  publishable: boolean;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "preview"; preview: PreviewInfo }
  | { type: "error"; message: string }
  | { type: "end" };

/**
 * Stream a chat turn.
 *
 * React Native's fetch does not expose a readable body stream, so this reads
 * the SSE response with XMLHttpRequest and parses incrementally off
 * `responseText`. That is the one reliable way to get token-by-token output on
 * a device without pulling in a polyfill.
 */
export function streamChat(
  appId: string,
  message: string,
  onEvent: (e: ChatEvent) => void,
): () => void {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${API_URL}/v1/apps/${appId}/chat`);
  xhr.setRequestHeader("content-type", "application/json");
  for (const [name, value] of Object.entries(authHeaders())) {
    xhr.setRequestHeader(name, value);
  }

  let consumed = 0;

  const drain = () => {
    const buffer = xhr.responseText.slice(consumed);
    // SSE frames are separated by a blank line; keep any partial tail.
    const frames = buffer.split("\n\n");
    const tail = frames.pop() ?? "";
    consumed += buffer.length - tail.length;

    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        if (event === "text") onEvent({ type: "text", text: parsed.text });
        else if (event === "tool") onEvent({ type: "tool", name: parsed.name });
        else if (event === "preview") onEvent({ type: "preview", preview: parsed });
        else if (event === "error") onEvent({ type: "error", message: parsed.message });
        else if (event === "run.end") onEvent({ type: "end" });
      } catch {
        // A partial frame that slipped through — the next drain picks it up.
      }
    }
  };

  xhr.onprogress = drain;
  xhr.onload = () => {
    drain();
    onEvent({ type: "end" });
  };
  xhr.onerror = () => onEvent({ type: "error", message: "Network request failed" });

  xhr.send(JSON.stringify({ message }));
  return () => xhr.abort();
}

export async function createApp(name: string, description: string) {
  const res = await fetch(`${API_URL}/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name, description }),
  });
  if (res.status === 401) throw new Error("Not authorised — check EXPO_PUBLIC_VON_API_KEY.");
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string };
}

/**
 * Ship what was previewed.
 *
 * Deliberately a separate call from the chat turn: publishing is what reaches
 * other people's phones, so it needs its own gesture rather than happening as a
 * side effect of asking for a change.
 */
export async function publish(appId: string): Promise<ReleaseInfo> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/publish`, {
    method: "POST",
    headers: authHeaders(),
  });
  const body = (await res.json()) as {
    error?: string;
    summary?: string;
    commitSha?: string | null;
    ship?: { decision: { kind: "ota" | "native" | "none" } } | null;
  };
  if (!res.ok) throw new Error(body.error ?? `publish failed: ${res.status}`);

  return {
    kind: body.ship?.decision.kind ?? "none",
    reason: body.summary ?? "",
    commit: body.commitSha ?? null,
  };
}

/** Is the live release in trouble, and can it be undone? */
export interface HealthInfo {
  crashReports: number;
  suspect: boolean;
  publishedAt: number | null;
  rollback: { available: boolean; to: string | null; reason: string | null };
}

export async function getHealth(appId: string): Promise<HealthInfo> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/health`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`health failed: ${res.status}`);

  const body = (await res.json()) as {
    crashReports: number;
    suspect: boolean;
    latest: { createdAt: number } | null;
    rollback: { available: boolean; to: string | null; reason: string | null };
  };

  return {
    crashReports: body.crashReports,
    suspect: body.suspect,
    publishedAt: body.latest?.createdAt ?? null,
    rollback: body.rollback,
  };
}

/** Undo the last release by republishing the one before it. */
export async function rollback(appId: string): Promise<string> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/rollback`, {
    method: "POST",
    headers: authHeaders(),
  });
  const body = (await res.json()) as { error?: string; summary?: string };
  // The control plane's refusals are written for a person — "that was a native
  // build" — so they are shown rather than reduced to a status code.
  if (!res.ok) throw new Error(body.error ?? `rollback failed: ${res.status}`);
  return body.summary ?? "Rolled back.";
}

/** Throw away an unpublished change and go back to what is live. */
export async function discardPreview(appId: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/preview`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`discard failed: ${res.status}`);
}
