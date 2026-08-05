import type { Message } from "../core/types.js";

/**
 * What a conversation may weigh before its OLDEST tool results are put away.
 *
 * Measured on one verification run before it was stopped: 1,033,926 characters of tool output in a single
 * conversation — 654,354 of it re-reads of one document — and every byte of it re-sent on every later call.
 * The conversation reached 168 messages and 200,193 characters per request, still climbing, at 23 requests
 * and 1.5M tokens. Nothing dropped anything: `working` only ever grew.
 *
 * The ceiling is generous on purpose. A run that fits under it behaves exactly as before, so this changes
 * nothing for ordinary work and only bites the runs that were already paying for themselves twice.
 */
export const MAX_CONVERSATION_CHARS = 250_000;

/**
 * How many of the most recent tool results are never touched.
 *
 * The last few are what the model is reasoning about right now; putting those away would make it re-fetch
 * them immediately, which is the cost this exists to avoid, paid twice.
 */
export const KEEP_RECENT_RESULTS = 12;

/** Below this, a result is not worth replacing: the stub would cost nearly as much as the content. */
const WORTH_STUBBING = 400;

/** What is left where a tool result was. */
export function stub(m: Message): string {
  const what = m.name ? `\`${m.name}\`` : "a tool";
  return `[${what} returned ${(m.content ?? "").length.toLocaleString("en-US")} characters here. `
    + `Put away to keep this conversation workable — call it again if you still need what it said.]`;
}

/**
 * Puts away the oldest tool results until the conversation fits, and returns it.
 *
 * Only tool RESULTS are touched. The system prompt, everything the user said, and everything the assistant
 * said are what the run is; a summary of those would be a different conversation. A tool result is the one
 * part that can be re-fetched at will — which is exactly why it is safe to drop and expensive to keep.
 *
 * Oldest first, because the oldest is the least likely to still be the subject: a document read twenty
 * reads ago has been re-read since, and the newer copy is the one that is true.
 */
export function compact(messages: Message[], max = MAX_CONVERSATION_CHARS): { messages: Message[]; freed: number } {
  const size = (ms: Message[]): number => ms.reduce((n, m) => n + (m.content ?? "").length, 0);
  let total = size(messages);
  if (total <= max) return { messages, freed: 0 };

  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const spare = new Set(toolIdx.slice(-KEEP_RECENT_RESULTS));
  const out = [...messages];
  let freed = 0;

  for (const i of toolIdx) {
    if (total <= max) break;
    if (spare.has(i)) continue;
    const m = out[i];
    const had = (m.content ?? "").length;
    if (had < WORTH_STUBBING) continue;
    const replaced = stub(m);
    out[i] = { ...m, content: replaced };
    const saved = had - replaced.length;
    total -= saved;
    freed += saved;
  }
  return { messages: out, freed };
}
