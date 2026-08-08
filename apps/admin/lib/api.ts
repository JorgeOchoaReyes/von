import type { App, ResourceRecord } from "@von/core";

const BASE = process.env.VON_API_URL ?? "http://localhost:8787";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const listApps = () => get<App[]>("/v1/apps");
export const getApp = (id: string) => get<App>(`/v1/apps/${id}`);
export const getResources = (id: string) => get<ResourceRecord[]>(`/v1/apps/${id}/resources`);
