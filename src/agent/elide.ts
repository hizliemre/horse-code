import type { Message } from "../core/types.js";

// Context growth is the dominant cost of a long agent run: there is no prompt-cache control here, so every
// turn re-bills the WHOLE conversation. A 200-turn implementer that read a few large files and ran a build
// therefore pays for those bytes dozens of times over (observed: ↑1.9M against ↓16.9k for one task).
//
// The bulk of that weight is TOOL OUTPUT — file contents, build logs, greps — and its value decays fast: the
// agent already read it and acted on it. So old tool results are elided down to a stub while everything else,
// including the message structure, is left exactly as it was.
//
// Structure is the reason this is not summarization: an assistant message's `toolCalls` must stay paired with
// the `tool` messages that answer them. Dropping or merging messages breaks that pairing and the provider
// rejects the request outright. Eliding only the BODY keeps every id, role and ordering intact.

/**
 * How much recent tool output is kept verbatim, in characters.
 *
 * A BUDGET, not a count. A fixed count is the wrong shape: a coding agent holds several files open while it
 * edits, and "keep the last 2 results" threw a file's contents away after two unrelated greps — leaving it to
 * edit from memory. A budget keeps many small results and only trims once the total genuinely weighs
 * something, which is the thing being paid for on every turn.
 */
export const RECENT_RESULT_BUDGET = 40_000;
/** The newest result is always kept, however large — it is what the agent is acting on right now. */
export const ALWAYS_KEEP_NEWEST = 1;
/** Below this size a tool result is not worth eliding; the stub would barely be smaller. */
export const ELIDE_MIN_CHARS = 1_500;

/** What an elided result says: enough to know something WAS there, and what to do about it. */
function stub(chars: number): string {
  return `[earlier tool output elided to save context — ${chars.toLocaleString("en-US")} chars. Re-run the tool if you still need it.]`;
}

/**
 * Returns a copy of `messages` with the bodies of older, large tool results replaced by a stub. The last
 * {@link KEEP_RECENT_RESULTS} tool results are always left untouched, as is every non-tool message.
 *
 * Non-destructive: the caller keeps its full history and re-elides per request, so nothing is permanently lost
 * from our own bookkeeping — only from what the model is billed for.
 *
 * NB: may return the SAME array when there is nothing to elide. Callers that hand the result to a provider
 * must pass a copy — the provider must never end up holding a reference to a live, growing history.
 */
export function elideOldToolResults(
  messages: Message[],
  opts: { budget?: number; minChars?: number } = {},
): Message[] {
  const budget = opts.budget ?? RECENT_RESULT_BUDGET;
  const min = opts.minChars ?? ELIDE_MIN_CHARS;
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "tool") toolIdx.push(i);
  if (toolIdx.length <= ALWAYS_KEEP_NEWEST) return messages;
  // Walk newest → oldest, keeping results until the budget is spent; everything older is elidable.
  const elidable = new Set<number>();
  let used = 0;
  for (let k = toolIdx.length - 1; k >= 0; k--) {
    const i = toolIdx[k];
    const size = messages[i].content.length;
    if (k >= toolIdx.length - ALWAYS_KEEP_NEWEST || used + size <= budget) { used += size; continue; }
    elidable.add(i);
  }
  let changed = false;
  const out = messages.map((m, i) => {
    if (!elidable.has(i) || m.content.length < min) return m;
    changed = true;
    return { ...m, content: stub(m.content.length) };
  });
  return changed ? out : messages;
}
