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
/**
 * How much is kept for the NEWEST result of each distinct thing the agent looked at, beyond the recency
 * budget.
 *
 * Recency alone built a treadmill. A coder holds several files open while it works; once a couple of large
 * reads pushed an earlier one out of the window, its stub told the agent to run the tool again — so it did,
 * which pushed something else out, which it then re-read. Measured on a real run: 496 tool calls in two and
 * a half minutes, the same three files over and over, until the twenty-minute attempt budget killed it. Of
 * 243 implementation attempts in one session, 31 died exactly that way.
 *
 * Keeping the LATEST copy of each distinct target removes the reason to re-read rather than arguing with it.
 * Bounded, because an agent that opens two hundred files must still not retain all of them.
 */
export const DISTINCT_RESULT_BUDGET = 120_000;
/** The newest result is always kept, however large — it is what the agent is acting on right now. */
export const ALWAYS_KEEP_NEWEST = 1;
/** Below this size a tool result is not worth eliding; the stub would barely be smaller. */
export const ELIDE_MIN_CHARS = 1_500;

/**
 * What an elided result says: enough to know something WAS there, and what to do about it.
 *
 * "Re-run the tool" is only ever printed for output that is genuinely gone. When a LATER call looked at the
 * same thing, the current version is still in the conversation and asking for it again is the treadmill this
 * elision exists to avoid — so that stub says where to look instead.
 */
function stub(chars: number): string {
  return `[earlier tool output elided to save context — ${chars.toLocaleString("en-US")} chars. Re-run the tool if you still need it.]`;
}

function supersededStub(chars: number): string {
  return `[earlier output elided — ${chars.toLocaleString("en-US")} chars. A LATER call in this conversation ` +
    `looked at the same thing; its result is below. Do not run it again.]`;
}

/**
 * What a call was about — the path, pattern or command that identifies what it looked at.
 *
 * The same list the chat line uses to label a call, for the same reason: it is the argument that says which
 * thing this was, so two calls that share it are two looks at one thing.
 */
export function subjectOf(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null) return "";
    const args = parsed as Record<string, unknown>;
    for (const key of ["path", "file", "file_path", "symbol", "pattern", "query", "command", "name", "url"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) return `${key}:${v.trim()}`;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * The stub for a past call's ARGUMENTS, which is not the same advice.
 *
 * "Re-run the tool" is right for a result you can fetch again; it is wrong for the arguments of a write,
 * where re-running means writing the file a second time. What the agent needs to know here is that the
 * value was sent and is gone, not that it should be sent again.
 */
function argStub(chars: number): string {
  return `[argument elided to save context — ${chars.toLocaleString("en-US")} chars, already applied. Read the file if you need it.]`;
}

/**
 * The elision plan for a history.
 *
 * `results` are the bodies to stub; `superseded` is the subset a later call has already looked at again;
 * `argIds` are the calls whose ARGUMENTS should shrink. The last is a wider set on purpose: keeping the
 * newest copy of each file the agent read is what stops it re-reading, and a `write_file`'s arguments are
 * not that — they are the body it just wrote, which it has no reason to be shown again.
 */
function planElision(
  messages: Message[],
  budget: number,
  distinctBudget: number,
): { results: Set<number>; superseded: Set<number>; argIds: Set<string> } {
  const results = new Set<number>();
  const superseded = new Set<number>();
  const argIds = new Set<string>();
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "tool") toolIdx.push(i);
  if (toolIdx.length <= ALWAYS_KEEP_NEWEST) return { results, superseded, argIds };

  const call = new Map<string, { name?: string; arguments: string }>();
  for (const m of messages) for (const c of m.toolCalls ?? []) call.set(c.id, { name: c.name, arguments: c.arguments });
  /**
   * The budget is spent on the WHOLE exchange — what was sent as well as what came back.
   *
   * Counting only results meant a run of writes never filled it: forty files went out as half a megabyte of
   * arguments and came back as "written" seven times over, so by the result-only measure nothing was ever
   * old enough to elide. What occupies the context is the traffic in both directions.
   */
  const cost = (i: number): number =>
    messages[i].content.length + (call.get(messages[i].toolCallId ?? "")?.arguments.length ?? 0);
  const keyOf = (i: number): string => {
    const c = call.get(messages[i].toolCallId ?? "");
    const subject = c ? subjectOf(c.arguments) : "";
    return subject ? `${c?.name ?? messages[i].name ?? ""}\u0000${subject}` : "";
  };

  /**
   * One walk, newest → oldest, classifying each exchange.
   *
   * `seen` is recorded for EVERY exchange, including those inside the recency window: an older read of a
   * file whose newest copy is right there is a duplicate whichever bucket that newest copy landed in, and
   * keeping it would pay twice for the same bytes.
   */
  const seen = new Set<string>();
  let used = 0;
  let usedDistinct = 0;
  for (let k = toolIdx.length - 1; k >= 0; k--) {
    const i = toolIdx[k];
    const key = keyOf(i);
    const first = key !== "" && !seen.has(key);
    if (key !== "") seen.add(key);

    // Inside the recency window nothing is touched — it is what the agent is working with right now.
    if (k >= toolIdx.length - ALWAYS_KEEP_NEWEST || used + cost(i) <= budget) { used += cost(i); continue; }

    // Outside it, the arguments always shrink: a write's arguments are the body it already sent, and no
    // amount of keeping them saves a later look-up.
    const id = messages[i].toolCallId;
    if (id) argIds.add(id);

    // The newest copy of each distinct target keeps its BODY — that is what removes the reason to look again.
    if (first && usedDistinct + messages[i].content.length <= distinctBudget) {
      usedDistinct += messages[i].content.length;
      continue;
    }
    results.add(i);
    // Only when we can NAME what was looked at: without a subject there is no way to know a later call
    // covered the same ground, and telling the agent not to look again would be a guess.
    if (!first && key !== "") superseded.add(i);
  }
  return { results, superseded, argIds };
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
  opts: { budget?: number; minChars?: number; distinctBudget?: number } = {},
): Message[] {
  const min = opts.minChars ?? ELIDE_MIN_CHARS;
  const { results, superseded } = planElision(
    messages, opts.budget ?? RECENT_RESULT_BUDGET, opts.distinctBudget ?? DISTINCT_RESULT_BUDGET);
  let changed = false;
  const out = messages.map((m, i) => {
    if (!results.has(i) || m.content.length < min) return m;
    changed = true;
    return { ...m, content: (superseded.has(i) ? supersededStub : stub)(m.content.length) };
  });
  return changed ? out : messages;
}

/**
 * Elides old tool results IN the history, freeing what they held.
 *
 * The pure version above elides only the COPY handed to the provider; the agent's own history kept every
 * result at full size for the life of the run. With a few hundred tool calls — a planner reached 820 — and
 * results capped at 30 KB each, one agent retains hundreds of megabytes it will never read again. Nine
 * agents at once is how a run reaches the heap ceiling after five hours.
 *
 * Safe because elision is one-way: the budget is spent walking newest to oldest, and messages are only ever
 * appended, so a result outside the budget can only get older. Nothing that has been elided can come back
 * into the window and be needed at full size again.
 *
 * Returns how many characters were released, so the saving is measurable rather than assumed.
 */
/**
 * Shrinks a past tool call's arguments, keeping what identifies it.
 *
 * A `write_file` call carries the entire file in its arguments — and those live on an ASSISTANT message,
 * which elision never touched. So the file body was retained for the life of the run AND re-sent on every
 * subsequent turn. Measured on a coder writing forty files: after eliding every result, 92% of what
 * remained was arguments.
 *
 * The short fields stay. `{"path":"src/x.ts"}` is what makes the history readable — it says which file was
 * written; the 12 KB of content says nothing the result did not already confirm.
 */
export function elideArgs(argumentsJson: string, minChars = ELIDE_MIN_CHARS): string {
  if (argumentsJson.length < minChars) return argumentsJson;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return argStub(argumentsJson.length);
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length >= minChars) { out[k] = argStub(v.length); changed = true; }
      else out[k] = v;
    }
    return changed ? JSON.stringify(out) : argumentsJson;
  } catch {
    // Not JSON (a partial or malformed call) — the whole thing is bulk with no structure worth keeping.
    return argStub(argumentsJson.length);
  }
}

export function elideInPlace(
  messages: Message[],
  opts: { budget?: number; minChars?: number; distinctBudget?: number } = {},
): number {
  const min = opts.minChars ?? ELIDE_MIN_CHARS;
  /**
   * The same plan the provider copy gets, so the history and what is billed never disagree.
   *
   * Two rules, both by POSITION rather than by size. Position, because keying off "was the reply big enough
   * to stub" was wrong in exactly the case that matters most: a `write_file` returns "written" — seven
   * characters, never elided — while carrying twelve kilobytes of file in its arguments. And the budget is
   * spent on the WHOLE exchange, sent as well as received: forty writes went out as half a megabyte of
   * arguments and came back as "written" seven times over, so by a result-only measure nothing was ever old
   * enough to elide at all.
   */
  const { results: oldIdx, superseded, argIds: oldIds } = planElision(
    messages, opts.budget ?? RECENT_RESULT_BUDGET, opts.distinctBudget ?? DISTINCT_RESULT_BUDGET);

  let freed = 0;
  for (const i of oldIdx) {
    const m = messages[i];
    if (m.content.length < min) continue;
    const text = (superseded.has(i) ? supersededStub : stub)(m.content.length);
    freed += m.content.length - text.length;
    messages[i] = { ...m, content: text };
  }
  for (const m of messages) {
    if (!m.toolCalls?.length) continue;
    for (const c of m.toolCalls) {
      if (!oldIds.has(c.id)) continue;
      const shorter = elideArgs(c.arguments, min);
      if (shorter === c.arguments) continue;
      freed += c.arguments.length - shorter.length;
      c.arguments = shorter;
    }
  }
  return freed;
}
