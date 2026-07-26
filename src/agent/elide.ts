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
 * Tool results this recent are kept verbatim — the agent is usually still working with them.
 *
 * Two, not four: the working set of an agent mid-edit is the file it just read and the command it just ran.
 * Anything older it has already acted on, and each retained result is re-billed on every remaining turn.
 */
export const KEEP_RECENT_RESULTS = 2;
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
  opts: { keepRecent?: number; minChars?: number } = {},
): Message[] {
  const keep = opts.keepRecent ?? KEEP_RECENT_RESULTS;
  const min = opts.minChars ?? ELIDE_MIN_CHARS;
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "tool") toolIdx.push(i);
  if (toolIdx.length <= keep) return messages;
  const elidable = new Set(toolIdx.slice(0, toolIdx.length - keep));
  let changed = false;
  const out = messages.map((m, i) => {
    if (!elidable.has(i) || m.content.length < min) return m;
    changed = true;
    return { ...m, content: stub(m.content.length) };
  });
  return changed ? out : messages;
}
