import Constants from "expo-constants";

export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  process.env.EXPO_PUBLIC_VON_API_URL ??
  "http://localhost:8787";

export interface ReleaseInfo {
  kind: "ota" | "native" | "none";
  reason: string;
  files: string[];
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "release"; release: ReleaseInfo }
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
        else if (event === "release") onEvent({ type: "release", release: parsed });
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string };
}
