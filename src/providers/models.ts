import type { FetchLike } from "./omniroute.js";

/** Fetches omniroute's model ids from GET /api/v1/models (sorted, de-duplicated). */
export async function listOmniRouteModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
}): Promise<string[]> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const base = opts.baseUrl.replace(/\/$/, "");
  const res = await fetchFn(`${base}/api/v1/models`, { headers });
  if (!res.ok) throw new Error(`omniroute models ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}
