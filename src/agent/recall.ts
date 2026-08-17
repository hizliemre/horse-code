/**
 * What an agent has already been shown, so it is not shown it again.
 *
 * Measured over one 577-minute run: 206 agents, 10,378 tool calls, of which 4,598 were `read_file` and 970
 * were `glob`. Counting only repeats an agent made INSIDE ITS OWN conversation — where the answer is already
 * sitting in its context — 1,141 of 6,743 reads and searches were literal repeats, one in six. The worst
 * single agent spent 113 of its 300 calls that way: `**\/safe-html.pipe.spec.ts` globbed fifteen times,
 * `project.json` read eight times.
 *
 * Repeats ACROSS agents are not waste and are not touched here: each agent has its own context, and a file it
 * has not read is a file it cannot use.
 *
 * Safe because the agent loop never drops messages — `working` only grows — so an earlier result is still
 * there to be referred back to. Any write invalidates everything: what the file said before the edit is not
 * what it says now, and a memo that answers from the old text is worse than the re-read it saved.
 */

/** Tools whose answer depends only on the tree, so an unchanged tree gives the same answer. */
export const RECALLABLE = new Set(["read_file", "grep", "glob", "graph_trace", "graph_find", "graph_context"]);

/** Anything that can change the tree. `shell` is judged by what it was asked to run — see `shellReadOnly`. */
export const INVALIDATING = new Set(["write_file", "edit_file"]);

/**
 * The command a shell call is about, out of its key (`command:git status|timeout=120000` → `git status`).
 *
 * `shellReadOnly` was written so that looking around does not wipe an agent's memo, and it has never once
 * been given something it could read. `note` passes the KEY — the same string telemetry records — and every
 * key is prefixed `command:` and suffixed `|timeout=…`. So `shellReadOnly("command:git status")` splits into
 * a first word of `command:git`, which is in no allowlist, and answers false: every shell call in the tool's
 * history has cleared everything the agent had read.
 *
 * Measured directly: `shellReadOnly("git status")` → true, `shellReadOnly("command:git status")` → false.
 * The function's own tests pass bare commands, which is why the whole path stayed green while never running.
 */
export function commandOfKey(key: string): string {
  const body = key.startsWith("command:") ? key.slice("command:".length) : key;
  const cut = body.lastIndexOf("|timeout=");
  return (cut === -1 ? body : body.slice(0, cut)).trim();
}

/** The path a call is about, out of its key (`path:src/a.ts|limit=40|offset=1` → `src/a.ts`). */
export function pathOfKey(key: string): string | undefined {
  const m = /^path:([^|]+)/.exec(key);
  return m ? m[1] : undefined;
}

/**
 * The span of a read, out of its key — `[start, end)` in lines, 1-based.
 *
 * A read with no `limit` is the WHOLE file, and that is the case this exists for: an agent that read a file
 * complete and then asks for lines 24-204 of it is asking for text it already has, in a call whose key is
 * different from the one it made. Keys were deliberately made range-aware once, because a monitor counting
 * sixteen pages of one file as sixteen re-reads reports a loop that is not there. That was right for
 * DISJOINT pages and wrong for CONTAINED ones.
 *
 * Measured on a feature run, in the first ten minutes: one brainstormer read `Order.cs` in full (15,302
 * characters) and then re-read subsets of it eight more times. Across every agent in the run, 50,479 of
 * 199,866 characters read — one character in four — was a range that agent already held.
 */
export function rangeOfKey(key: string): { start: number; end: number } {
  const lim = /\|limit=(\d+)/.exec(key);
  const off = /\|offset=(\d+)/.exec(key);
  const start = off ? Number(off[1]) : 1;
  return { start, end: lim ? start + Number(lim[1]) : Number.MAX_SAFE_INTEGER };
}

/**
 * Commands that only look. Everything else is treated as a write, including anything unrecognised.
 *
 * A `git status` through shell used to wipe an agent's whole memo, and read-only git through shell is what
 * agents do most: 298 of one run's 1,216 shell commands were git, and 320 of the 356 verbs in them read
 * nothing. Forgetting everything each time would have cancelled most of what the memo is for.
 *
 * The list is deliberately short and the parse deliberately strict: a command is read-only only when EVERY
 * segment of it is, and any redirection or substitution disqualifies the whole thing.
 */
const READING = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "echo", "true",
  "find", "grep", "rg", "which", "basename", "dirname", "realpath", "date", "env", "printenv",
]);
const GIT_READING = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "branch", "remote",
  "describe", "shortlog", "reflog", "cat-file", "worktree", "config", "tag", "cherry", "merge-base",
]);

export function shellReadOnly(commandOrKey: string): boolean {
  // Tolerant of a key as well as a command: a caller that gets this wrong fails SILENTLY and expensively,
  // and one already did. Stripping here costs nothing and removes the only way to hold it wrong.
  const command = commandOfKey(commandOrKey);
  if (/[><]|\$\(|`|>>|\btee\b|\bxargs\b/.test(command)) return false;  // …anything that can write, or hide a write
  const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((seg) => {
    const words = seg.split(/\s+/).filter(Boolean);
    const [head, ...rest] = words;
    if (head === "git") {
      // `git -C <dir> status` — skip the options that come before the verb.
      const verb = rest.find((w) => !w.startsWith("-") && !/^[./~]/.test(w) && rest[rest.indexOf(w) - 1] !== "-C");
      return verb !== undefined && GIT_READING.has(verb) && !rest.includes("--set") && !rest.includes("add");
    }
    return READING.has(head ?? "");
  });
}

export class Recall {
  private readonly seen = new Map<string, number>();
  /** Line spans of `read_file` answers already given, per path — see rangeOfKey. */
  private readonly spans = new Map<string, { start: number; end: number; turn: number }[]>();
  /** Paths this agent WROTE in full — their current content is its own words, one call back. */
  private readonly authored = new Map<string, number>();
  private turn = 0;

  /** Advances the clock; called once per model turn so the reminder can say WHEN. */
  nextTurn(): void {
    this.turn++;
  }

  /**
   * The memo's own key. One producer, because three call sites building the same string by hand is how
   * `forget` came to use a space where `note` uses a NUL and silently deleted nothing.
   */
  private id(tool: string, key: string): string {
    return `${tool}\u0000${key}`;
  }

  /** The turn an identical call was answered on, or undefined if this one is new. */
  saw(tool: string, key: string): number | undefined {
    return this.recall(tool, key)?.turn;
  }

  /** The turn it was answered on, and whether the answer is the agent's OWN write rather than a result. */
  recall(tool: string, key: string): { turn: number; authored: boolean } | undefined {
    if (!RECALLABLE.has(tool) || !key) return undefined;
    const direct = this.seen.get(this.id(tool, key));
    if (direct !== undefined) return { turn: direct, authored: false };
    // …and neither is a slice of something already answered in full. See rangeOfKey.
    if (tool === "read_file") {
      const p = pathOfKey(key);
      const want = rangeOfKey(key);
      const held = p !== undefined ? this.spans.get(p) : undefined;
      const covering = held?.find((h) => want.start >= h.start && want.end <= h.end);
      if (covering) return { turn: covering.turn, authored: false };
    }
    // A read of a file this agent wrote in full, at any offset: the content is its own, in the call it made.
    const path = tool === "read_file" ? pathOfKey(key) : undefined;
    const wrote = path !== undefined ? this.authored.get(path) : undefined;
    return wrote !== undefined ? { turn: wrote, authored: true } : undefined;
  }

  /**
   * Drops a specific answer, because it is no longer in the conversation to be read.
   *
   * Compaction replaces the oldest tool results with a stub. The memo's whole premise — "the result is above,
   * read it there" — stops being true for exactly those, and a memo that refuses a call while pointing at
   * something that is no longer there leaves the agent with no way forward. See src/agent/compact.ts.
   */
  forget(entries: { tool: string; key: string }[]): void {
    for (const e of entries) {
      this.seen.delete(this.id(e.tool, e.key));
      // …and a written file whose result was put away is no longer held either.
      const p = pathOfKey(e.key);
      if (p !== undefined) { this.authored.delete(p); this.spans.delete(p); }
    }
  }

  /**
   * Records a call, or forgets what it could have changed.
   *
   * A write used to clear the WHOLE memo, which is true only of a write that could have touched anything.
   * `write_file` and `edit_file` touch ONE path, and writing `plan.md` says nothing about `UpdateProduct.cs`
   * — so everything the agent had learned about the rest of the tree was thrown away on every write. A shell
   * command is different and still clears everything: it can do anything, and `shellReadOnly` is the only
   * thing standing between it and that.
   */
  note(tool: string, key: string): void {
    if (INVALIDATING.has(tool)) { this.wrote(tool, key); return; }
    // The KEY, not the command — see commandOfKey for the years this cost.
    if (tool === "shell") {
      if (!shellReadOnly(commandOfKey(key))) { this.seen.clear(); this.spans.clear(); }
      return;
    }
    if (!RECALLABLE.has(tool) || !key) return;
    if (!this.seen.has(this.id(tool, key))) this.seen.set(this.id(tool, key), this.turn);
    if (tool === "read_file") {
      const p = pathOfKey(key);
      if (p !== undefined) {
        const span = { ...rangeOfKey(key), turn: this.turn };
        this.spans.set(p, [...(this.spans.get(p) ?? []), span]);
      }
    }
  }

  /**
   * A write drops what was known about THAT path — and, for a whole-file write, records the agent as
   * already holding it.
   *
   * `write_file` carries the complete new content in the call the agent just made, so re-reading the file
   * afterwards asks for something it wrote a moment ago. Measured on one planner: `specs/spec.md` read for
   * 1,541,324 characters and `specs/plan.md` for 1,366,926 — its own two documents, 58% of everything it
   * read, in a run that made 806 reads and 3 writes.
   *
   * `edit_file` is deliberately NOT recorded that way: the agent supplied a replacement, not the file, so it
   * has no basis for claiming to know what the whole thing now says.
   */
  private wrote(tool: string, key: string): void {
    const path = pathOfKey(key);
    if (!path) { this.seen.clear(); this.spans.clear(); return; }   // cannot tell what changed → conservative
    this.spans.delete(path);   // what it said before the write is not what it says now
    for (const k of [...this.seen.keys()]) {
      if (pathOfKey(k.slice(k.indexOf("\u0000") + 1)) === path) this.seen.delete(k);
    }
    /**
     * The claim is re-decided on every write, never inherited.
     *
     * A `write_file` followed by an `edit_file` leaves the agent holding its original text plus a patch —
     * not the file. Keeping the earlier claim would answer a read with "you wrote this yourself" about
     * content it no longer has in one piece, which is the wrong-pointer failure this whole mechanism has
     * already caused once.
     */
    this.authored.delete(path);
    if (tool === "write_file") this.authored.set(path, this.turn);
  }
}

/**
 * What the agent is told instead of the content.
 *
 * It names the call and where the answer is, so the agent can look up rather than ask again — and says
 * plainly what to do if it wanted a fresh read, so a genuine re-read is one step away rather than blocked.
 */
export function recallNote(tool: string, subject: string, turn: number, authored = false): string {
  /**
   * A file the agent WROTE is pointed at differently, because it is somewhere else.
   *
   * The general note says "its result is above", and for an authored file there is no result — the content
   * is in the write call the agent itself made. Pointing at the wrong place is exactly what deadlocked a run
   * once already: compaction removed a result while this note insisted it was still there.
   */
  if (authored) {
    return `You wrote \`${subject}\` yourself on turn ${turn} of this conversation — its current content is `
      + `the text you passed to \`write_file\`, above. Read it there rather than fetching it back. If it has `
      + `been changed since by something other than your own tools, say so and ask again.`;
  }
  return `Already answered on turn ${turn} of this conversation: \`${tool}\`${subject ? ` on ${subject}` : ""}. `
    + `Its result is above — read it there rather than asking again. Nothing has been written since, so the `
    + `answer is unchanged. If you need it re-read because you changed it outside these tools, say so and ask again.`;
}
