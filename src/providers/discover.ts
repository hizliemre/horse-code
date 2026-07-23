import type { FetchLike } from "./omniroute.js";
import { isFreeModel } from "./models.js";

export interface CatalogModel {
  id: string;
  owned_by?: string;
  name?: string;
}

/** Fetches the raw omniroute model catalog (id + owned_by + name) — needed to group models by source. */
export async function fetchCatalog(opts: { baseUrl: string; apiKey?: string; fetch?: FetchLike }): Promise<CatalogModel[]> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetchFn(`${opts.baseUrl.replace(/\/$/, "")}/api/v1/models`, { headers });
  if (!res.ok) throw new Error(`omniroute models ${res.status}`);
  const body = (await res.json()) as { data?: CatalogModel[] };
  return (body.data ?? []).filter((m) => typeof m?.id === "string");
}

/**
 * Builds a source-reachability probe: a minimal completion against one model. A CONNECTED subscription
 * returns 200 (or 429 = rate-limited but routed); an unconfigured source errors (502 "not found / run
 * login", 418 challenge, etc.). So 200/429 = the source is wired; anything else = not connected.
 */
export function makeProbe(opts: { baseUrl: string; apiKey?: string; fetch?: FetchLike; timeoutMs?: number }): (model: string) => Promise<boolean> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  return async (model: string): Promise<boolean> => {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status === 200 || res.status === 429; // routed (429 = rate-limited but the subscription exists)
    } catch {
      return false;
    }
  };
}

// omniroute's own meta/router sources — not real subscriptions (the user's combos are handled separately).
const META_SOURCES = new Set(["combo"]);
// A cheap/fast model makes the most reliable probe (no slow "thinking" model timing out).
const isCheapModel = (id: string): boolean => /haiku|flash|mini|lite|\bfast\b/i.test(id);

export interface DiscoverOpts {
  catalog: CatalogModel[];
  probe: (model: string) => Promise<boolean>;
}

/**
 * Discovers which sources (omniroute `owned_by`) are actually connected: groups the non-free catalog by
 * source, probes ONE model per source in parallel, and returns the sources whose probe succeeded.
 */
export async function discoverSources(opts: DiscoverOpts): Promise<string[]> {
  const probeModel = new Map<string, string>(); // owned_by → the model to probe (prefer a cheap/fast one)
  for (const m of opts.catalog) {
    if (!m.owned_by || isFreeModel(m.id, m.name) || META_SOURCES.has(m.owned_by)) continue; // skip free + omniroute meta
    const cur = probeModel.get(m.owned_by);
    if (!cur || (isCheapModel(m.id) && !isCheapModel(cur))) probeModel.set(m.owned_by, m.id); // upgrade to a cheaper probe
  }
  const entries = [...probeModel.entries()];
  const results = await Promise.all(entries.map(async ([source, model]) => ({ source, ok: await opts.probe(model) })));
  return results.filter((r) => r.ok).map((r) => r.source).sort();
}
