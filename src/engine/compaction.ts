import type { Message } from "../core/types.js";

/** Rough token estimate (≈4 chars/token) — good enough to decide when to compact. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Estimated token size of a message history. */
export function historyTokens(history: Message[]): number {
  return history.reduce((a, m) => a + estTokens(m.content), 0);
}

const charsOf = (history: Message[]): number => history.reduce((a, m) => a + m.content.length, 0);
const summaryMsg = (summary: string): Message => ({ role: "user", content: `[Summary of the earlier conversation]\n${summary}` });
const render = (history: Message[]): string => history.map((m) => `${m.role}: ${m.content}`).join("\n\n");

/**
 * Cached compaction state carried across turns. `summary` covers the first `coveredCount` messages of the
 * history; `coveredChars` fingerprints that prefix so a changed transcript (/clear, /resume) invalidates it.
 */
export interface CompactionCache {
  coveredCount: number;
  coveredChars: number;
  summary: string;
}

export interface CompactionOpts {
  maxTokens: number; // compact only when the history exceeds this budget
  keepRecent: number; // number of tail messages kept verbatim
  reSummarizeTokens: number; // re-fold the un-summarized delta into the summary once it grows past this
  summarize: (conversation: string) => Promise<string>; // one LLM call over the region to summarize
}

/** True when the cache still describes a matching prefix of `history` up to `upTo`. */
function cacheValid(cache: CompactionCache | undefined, history: Message[], upTo: number): cache is CompactionCache {
  return (
    !!cache &&
    cache.coveredCount > 0 &&
    cache.coveredCount <= upTo &&
    charsOf(history.slice(0, cache.coveredCount)) === cache.coveredChars
  );
}

/**
 * Two-layer context: the full transcript stays on disk; the array sent to the model is compacted once it
 * exceeds the budget. Incrementally cached — the summarized prefix is reused across turns, and the small
 * not-yet-summarized delta is kept verbatim until it grows past `reSummarizeTokens`, so a summarizer LLM
 * call fires only occasionally instead of every turn. Returns the compacted messages + the updated cache.
 */
export async function compactHistory(
  history: Message[],
  opts: CompactionOpts,
  cache?: CompactionCache,
): Promise<{ messages: Message[]; cache?: CompactionCache }> {
  if (history.length <= opts.keepRecent + 1) return { messages: history, cache };
  if (historyTokens(history) <= opts.maxTokens) return { messages: history, cache };

  const ancientEnd = history.length - opts.keepRecent;
  const recent = history.slice(ancientEnd);
  const base = cacheValid(cache, history, ancientEnd)
    ? { coveredCount: cache.coveredCount, summary: cache.summary }
    : { coveredCount: 0, summary: "" };
  const delta = history.slice(base.coveredCount, ancientEnd);

  // Small delta on a valid cache → reuse the summary, keep the delta verbatim, NO summarizer call.
  if (base.coveredCount > 0 && historyTokens(delta) < opts.reSummarizeTokens) {
    return { messages: [summaryMsg(base.summary), ...delta, ...recent], cache };
  }

  // First compaction, or the delta grew big enough → fold it into the summary (one summarizer call).
  const conversation = base.summary
    ? `Existing summary:\n${base.summary}\n\nAdditional earlier turns to fold in:\n${render(delta)}`
    : render(delta);
  const summary = await opts.summarize(conversation);
  const next: CompactionCache = { coveredCount: ancientEnd, coveredChars: charsOf(history.slice(0, ancientEnd)), summary };
  return { messages: [summaryMsg(summary), ...recent], cache: next };
}
