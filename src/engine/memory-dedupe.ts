import type { ChatRequest, Provider } from "../core/types.js";
import { relationStrength, type MemoryEntry } from "./memory-retrieval.js";

/**
 * Collapsing the same claim discovered twice.
 *
 * `hygiene` already merges entries whose TEXT normalizes to the same string, which catches a fact saved
 * twice verbatim. It cannot catch what actually happens when work runs in parallel: two tasks discover the
 * same thing and write it in their own words. Both survive, both are injected, and the pool grows a pair of
 * near-twins for every shared discovery — the memory equivalent of the stale worktree copy.
 *
 * A model is the only reader that can tell "the store adapter lives in src/store.ts" from "persistence is
 * behind DataServicePort" — same subject, different claims — while also seeing that "never hardcode display
 * text" and "all user-visible strings must go through translation" are one rule said twice.
 *
 * But a model cannot be asked about 1471 entries pairwise: that is a million comparisons. So the work is
 * split. A cheap structural pass proposes GROUPS that are plausibly the same claim — same kind, and a shared
 * anchor or a strong tag overlap — and the model is asked only about those. On a real pool that is a handful
 * of groups, not a million pairs.
 */

/** How alike two entries must be structurally before a model is asked about them at all. */
export const CANDIDATE_BAR = 0.6;

/** Never send more than this many groups to one call — a long list is one the model stops reading. */
export const MAX_GROUPS = 12;

export interface DuplicateGroup {
  /** Entry ids, in the order they were written; the first is the incumbent. */
  ids: string[];
  texts: string[];
}

/**
 * Groups that MIGHT be the same claim, by structure alone.
 *
 * Deliberately generous: this decides what is worth asking about, and the model decides what is true. Being
 * generous costs one line in a prompt; being strict loses the duplicate silently.
 */
export function duplicateCandidates(entries: MemoryEntry[]): DuplicateGroup[] {
  const groups: MemoryEntry[][] = [];
  const placed = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!;
    if (placed.has(a.id)) continue;
    const group = [a];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!;
      if (placed.has(b.id)) continue;
      // A lesson and a fact that read alike are different claims about different things — never merged.
      if ((a.kind ?? "fact") !== (b.kind ?? "fact")) continue;
      if (relationStrength(a, b) < CANDIDATE_BAR) continue;
      group.push(b);
      placed.add(b.id);
    }
    if (group.length > 1) { placed.add(a.id); groups.push(group); }
  }
  return groups.map((g) => ({ ids: g.map((e) => e.id), texts: g.map((e) => e.text) }));
}

const SYSTEM =
  "You reconcile a project's memory. You are conservative: two notes about the same file are not the same "
  + "note, and you never merge claims that could both be true and separately useful.";

const PROMPT = (groups: DuplicateGroup[]): string =>
  `Each group below holds notes that MIGHT be the same thing said twice, by different workers that could not `
  + `see each other.\n\nFor each group, decide which notes state the SAME claim. Merge only those.\n\n`
  + `- If they say the same thing, give ONE wording that keeps every specific detail from all of them `
  + `(file names, identifiers, exceptions, numbers). Losing a detail is worse than keeping two notes.\n`
  + `- If they are about the same subject but state DIFFERENT things, do not merge them.\n`
  + `- If one is a strictly more complete version of another, merge into the complete one.\n\n`
  + groups.map((g, i) => `GROUP ${i}:\n${g.texts.map((t, j) => `  [${j}] ${t}`).join("\n")}`).join("\n\n")
  + `\n\nAnswer with a fenced json block: {"merges":[{"group":0,"indexes":[0,1],"text":"..."}]}\n`
  + `Include only the groups you are merging; omit the rest.`;

export interface Merge {
  /** The ids being collapsed — the first is kept and rewritten, the rest are dropped. */
  ids: string[];
  text: string;
}

function parse(out: string, groups: DuplicateGroup[]): Merge[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const raw = fence ? fence[1] : out.slice(out.indexOf("{"));
  let parsed: { merges?: unknown };
  try { parsed = JSON.parse(raw) as { merges?: unknown }; } catch { return []; }
  if (!Array.isArray(parsed.merges)) return [];
  const out2: Merge[] = [];
  for (const m of parsed.merges as { group?: unknown; indexes?: unknown; text?: unknown }[]) {
    const g = groups[typeof m.group === "number" ? m.group : -1];
    if (!g || typeof m.text !== "string" || !m.text.trim() || !Array.isArray(m.indexes)) continue;
    const ids = (m.indexes as unknown[])
      .filter((n): n is number => typeof n === "number" && n >= 0 && n < g.ids.length)
      .map((n) => g.ids[n]!);
    // One id is not a merge, and a merge must not invent an id that was never in its group.
    if (new Set(ids).size > 1) out2.push({ ids: [...new Set(ids)], text: m.text.trim() });
  }
  return out2;
}

/**
 * Asks a model which of the proposed groups are genuinely one claim.
 *
 * Returns an empty list when it cannot say — including when every model in the chain is spent. Nothing is
 * merged on a guess: two notes cost a little context, and a wrong merge deletes something the project knew.
 */
export async function dedupeMemories(opts: {
  provider: Provider;
  models: string[];
  entries: MemoryEntry[];
  signal?: AbortSignal;
}): Promise<Merge[]> {
  const groups = duplicateCandidates(opts.entries).slice(0, MAX_GROUPS);
  if (!groups.length) return [];
  for (const model of opts.models.filter(Boolean)) {
    const req: ChatRequest = {
      model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: PROMPT(groups) }],
      tools: [],
    };
    let out = "";
    try {
      for await (const ev of opts.provider.chat(req, opts.signal ?? new AbortController().signal)) {
        if (ev.type === "text-delta") out += ev.text;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    } catch {
      continue; // a spent model must not silently mean "no duplicates"
    }
    return parse(out, groups);
  }
  return [];
}

/**
 * Applies merges to a pool: the first id of each merge keeps the entry and takes the new wording, the rest
 * are dropped. Pure — the caller persists the result.
 *
 * The keeper inherits the others' usage counts, because they measured the same claim being useful; throwing
 * them away would make a well-earned memory look untested the moment it was tidied up.
 */
export function applyMerges(entries: MemoryEntry[], merges: Merge[]): { entries: MemoryEntry[]; removed: number } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const dropped = new Set<string>();
  for (const m of merges) {
    const keeper = byId.get(m.ids[0]!);
    if (!keeper) continue;
    const others = m.ids.slice(1).map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
    if (!others.length) continue;
    keeper.text = m.text;
    keeper.uses = (keeper.uses ?? 0) + others.reduce((n, o) => n + (o.uses ?? 0), 0);
    keeper.injections = (keeper.injections ?? 0) + others.reduce((n, o) => n + (o.injections ?? 0), 0);
    keeper.observedInjections = (keeper.observedInjections ?? 0)
      + others.reduce((n, o) => n + (o.observedInjections ?? 0), 0);
    for (const o of others) dropped.add(o.id);
  }
  return { entries: entries.filter((e) => !dropped.has(e.id)), removed: dropped.size };
}
