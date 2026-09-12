/**
 * How much of a delegated agent's work was asking the same question twice.
 *
 * `recall.ts` exists because of a measurement: over one 577-minute run, 1,141 of 6,743 reads and searches
 * were literal repeats INSIDE a single agent's own conversation — one in six — with one agent spending 113 of
 * its 300 calls that way. On the API path horse-code runs the tool loop, so it can see a repeat coming and
 * answer it from what the agent already has.
 *
 * On the delegated path the loop belongs to the CLI, and `recall` went blind. There is no reason to think the
 * waste stopped; only that nobody is counting it. So this counts it.
 *
 * Counting, and nothing else. Intervening would mean answering a tool call across a process boundary — the
 * one thing `cli-provider` deliberately refuses to rebuild — and a number nobody has is worth more than a
 * mechanism nobody trusts. If it turns out to be one in six here too, that is the argument for doing
 * something; if it turns out to be one in fifty, the argument is that `recall` earned its keep and the CLIs
 * have their own.
 */

/** One tool call as the stream reported it. A call with no target is still a call. */
export interface ToolCall {
  name: string;
  target?: string;
}

export interface RepeatReport {
  /** Every tool call seen, repeats included. */
  calls: number;
  /** Calls that asked something already asked in this same conversation. */
  repeats: number;
  /** The worst offenders, most-repeated first — what a person would want named. */
  worst: { key: string; times: number }[];
}

/**
 * What makes two calls the same question.
 *
 * The tool AND its target, because neither alone is the question: `read_file` twice on different files is
 * two questions, and `read_file` and `grep` on one file are two different things to learn about it. A call
 * whose target the stream did not name cannot be compared — it is counted, never matched — since treating
 * every unnamed call as identical would report a long agent as almost entirely repetition.
 */
export function callKey(c: ToolCall): string | undefined {
  return c.target ? `${c.name}:${c.target}` : undefined;
}

/**
 * Counts repeats within ONE conversation.
 *
 * Per conversation on purpose. A file two different agents each read once is not waste — each has its own
 * context, and a file an agent has not read is a file it cannot use. That distinction is `recall`'s too, and
 * getting it wrong would turn ordinary parallel work into an alarming number.
 */
export class RepeatWatch {
  private readonly seen = new Map<string, number>();
  private calls = 0;

  add(c: ToolCall): void {
    this.calls++;
    const key = callKey(c);
    if (!key) return;
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  report(): RepeatReport {
    let repeats = 0;
    const worst: { key: string; times: number }[] = [];
    for (const [key, times] of this.seen) {
      if (times < 2) continue;
      repeats += times - 1; // the first ask was not a repeat
      worst.push({ key, times });
    }
    worst.sort((a, b) => b.times - a.times || a.key.localeCompare(b.key));
    return { calls: this.calls, repeats, worst: worst.slice(0, 5) };
  }
}

/** One line for the record, or nothing when there was nothing to say. */
export function describeRepeats(r: RepeatReport): string | undefined {
  if (!r.repeats) return undefined;
  const share = Math.round((r.repeats / Math.max(1, r.calls)) * 100);
  const named = r.worst.map((w) => `${w.key} ×${w.times}`).join(", ");
  return `${r.repeats} of ${r.calls} tool calls repeated something already asked (${share}%) — ${named}`;
}
