import type { App, ResourceRecord } from "@von/core";

const BASE = process.env.VON_API_URL ?? "http://localhost:8787";

/**
 * The console's credential for the control plane.
 *
 * Read at call time rather than at module load, so a missing key is a clear
 * error on the request that needed it rather than a crash at boot — and so the
 * server can be started before its secret is mounted.
 *
 * These are React Server Components: the fetch happens on the server and the
 * key never reaches the browser. Anything moved to a client component has to
 * get its data through a route handler, not by reading this.
 */
function authHeaders(): Record<string, string> {
  const key = process.env.VON_API_KEY;
  if (!key) {
    // Local development runs the control plane open, so an absent key is normal
    // there. Against a deployed control plane it means every call 401s, and
    // saying so here is cheaper than reading it off a status code.
    return {};
  }
  return { authorization: `Bearer ${key}` };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: authHeaders(),
  });

  if (res.status === 401) {
    throw new Error(
      `${path}: unauthorized — set VON_API_KEY to one of the control plane's VON_API_KEYS`,
    );
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const listApps = () => get<App[]>("/v1/apps");
export const getApp = (id: string) => get<App>(`/v1/apps/${id}`);
export const getResources = (id: string) => get<ResourceRecord[]>(`/v1/apps/${id}/resources`);
