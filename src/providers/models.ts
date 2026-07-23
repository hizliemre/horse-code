import type { FetchLike } from "./omniroute.js";

/** Fetches omniroute's model ids from GET /api/v1/models (sorted, de-duplicated). */
/**
 * A free/unofficial model, detected from omniroute's metadata: a 🆓 (or "free") in the display name, a
 * "-free" suffix in the id, or a free-tier provider (e.g. veo-free). We exclude these — they're typically
 * unofficial reverse-proxy sources (rate-limited, unreliable) rather than the user's paid subscriptions.
 */
export function isFreeModel(id: string, name?: string): boolean {
  const n = name ?? "";
  if (/🆓/.test(n) || /\bfree\b/i.test(n)) return true;
  if (/-free\b/i.test(id)) return true;
  return /free/i.test(id.split("/")[0]); // provider segment like "veo-free"
}

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
  const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
  const ids = (body.data ?? [])
    .filter((m): m is { id: string; name?: string } => typeof m.id === "string")
    .filter((m) => !isFreeModel(m.id, typeof m.name === "string" ? m.name : undefined)) // drop free/unofficial models
    .map((m) => m.id);
  return [...new Set(ids)].sort();
}
