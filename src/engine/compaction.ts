import type { Message } from "../core/types.js";

/** Rough token estimate (≈4 chars/token) — good enough to decide when to compact. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Estimated token size of a message history. */
export function historyTokens(history: Message[]): number {
  return history.reduce((a, m) => a + estTokens(m.content), 0);
}

export interface CompactionOpts {
  maxTokens: number; // compact only when the history exceeds this budget
  keepRecent: number; // number of tail messages kept verbatim
  summarize: (conversation: string) => Promise<string>; // one LLM call over the ancient region
}

/**
 * Two-layer context: the full transcript stays on disk, but the array sent to the model is compacted
 * once it exceeds the budget — the ancient region is summarized into one message and the recent tail is
 * kept verbatim. Returns the history unchanged when it's short enough (no LLM call).
 */
export async function compactHistory(history: Message[], opts: CompactionOpts): Promise<Message[]> {
  if (history.length <= opts.keepRecent + 1) return history; // too short to be worth compacting
  if (historyTokens(history) <= opts.maxTokens) return history; // under budget → send as-is
  const recent = history.slice(-opts.keepRecent);
  const ancient = history.slice(0, history.length - opts.keepRecent);
  const rendered = ancient.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  const summary = await opts.summarize(rendered);
  const summaryMsg: Message = { role: "user", content: `[Summary of the earlier conversation]\n${summary}` };
  return [summaryMsg, ...recent];
}
