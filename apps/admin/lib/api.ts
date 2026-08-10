import type { App, Release, ResourceRecord } from "@von/core";

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

/** Mirrors `ReleaseHealth` from @von/release, which is server-only. */
export interface ReleaseHealth {
  latest: Release | null;
  crashReports: number;
  suspect: boolean;
  rollback: { available: boolean; to: string | null; reason: string | null };
}

export const listApps = () => get<App[]>("/v1/apps");
export const getApp = (id: string) => get<App>(`/v1/apps/${id}`);
export const getResources = (id: string) => get<ResourceRecord[]>(`/v1/apps/${id}/resources`);
export const listReleases = (id: string) => get<Release[]>(`/v1/apps/${id}/releases`);
export const getHealth = (id: string) => get<ReleaseHealth>(`/v1/apps/${id}/health`);

/**
 * Undo the last release.
 *
 * A write, so unlike the reads above it reports the control plane's own refusal
 * text rather than a status code: "the last release was a native build" is the
 * answer the operator needs, and a 409 alone is not.
 */
/**
 * `migrate` copies the app's data across; `reset` accepts leaving it behind.
 * The API refuses without one of them, which is what stops a stray curl from
 * stranding a customer's documents.
 */
export async function promote(id: string, mode: "migrate" | "reset"): Promise<string> {
  const res = await fetch(`${BASE}/v1/apps/${id}/promote`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(
      mode === "migrate" ? { migrateData: true } : { acknowledgeDataReset: true },
    ),
  });
  const body = (await res.json()) as {
    error?: string;
    firebaseProjectId?: string;
    migrated?: boolean;
  };
  if (!res.ok) throw new Error(body.error ?? `promote failed: ${res.status}`);
  return body.migrated
    ? `Promoted to ${body.firebaseProjectId} with data copied.`
    : `Promoted to ${body.firebaseProjectId}; data left in the pool.`;
}

export interface FleetPlan {
  dryRun: true;
  wouldUpdate: Array<{ id: string; name: string; repo: string | null }>;
  skipped: number;
}

export interface FleetSummary {
  total: number;
  succeeded: number;
  failed: number;
  results?: Array<{ appId: string; status: string; error?: string }>;
}

/**
 * Apply one instruction across many apps.
 *
 * Always previewed first from the console. A fleet update edits every generated
 * repository the platform owns, so "which apps would this touch" is a question
 * worth answering before the answer is a list of commits.
 */
export async function fleetUpdate(
  instruction: string,
  dryRun: boolean,
): Promise<FleetPlan | FleetSummary> {
  const res = await fetch(`${BASE}/v1/fleet/update`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ instruction, dryRun }),
  });
  const body = (await res.json()) as { error?: string } & (FleetPlan | FleetSummary);
  if (!res.ok) throw new Error(body.error ?? `fleet update failed: ${res.status}`);
  return body;
}

export async function rollbackApp(id: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/apps/${id}/rollback`, {
    method: "POST",
    cache: "no-store",
    headers: authHeaders(),
  });
  const body = (await res.json()) as { error?: string; summary?: string };
  if (!res.ok) throw new Error(body.error ?? `rollback failed: ${res.status}`);
  return body.summary ?? "Rolled back.";
}
