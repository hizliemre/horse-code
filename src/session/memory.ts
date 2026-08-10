import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomic } from "./atomic.js";
import { stateRoot, writableStateRoot } from "../engine/session-scope.js";
import { dedupeMemories, applyMerges } from "../engine/memory-dedupe.js";
import type { Provider } from "../core/types.js";
import { readFileSync, statSync } from "node:fs";
import { deriveAnchors, deriveTags, supersedes, hashAnchors, verifyAnchors, isExpired, SHORT_TTL_MS, type AnchorFs, type MemoryEntry } from "../engine/memory-retrieval.js";
import { hygiene, type HygieneReport } from "../engine/memory-hygiene.js";

/** Files larger than this are fingerprinted by size+mtime instead of content (cheap, still change-sensitive). */
const HASH_MAX_BYTES = 512 * 1024;

export interface MemoryStoreOpts {
  home: string; // kept for API compatibility; memory is now project-local, not under home
  cwd: string;
  now?: () => number;
}

/**
 * Per-project cross-session memory: durable facts/rules/lessons the user asks to remember, retrieved lexically
 * and injected into later turns. Stored PROJECT-LOCAL at <cwd>/.horsecode/memory.jsonl so it is committed with
 * the repo and shared with the team (a teammate who pulls the project gets the memory too) — not in the global
 * home. A sibling .gitignore keeps the secret-bearing config out of git while allowing memory.jsonl to be shared.
 */
export class MemoryStore {
  private file: string;
  private readonly now: () => number;
  private cache?: MemoryEntry[];
  private queue: Promise<unknown> = Promise.resolve(); // serializes mutations (safe under parallel writers)

  /** Runs a mutation with exclusive access → no interleaved read-modify-write across concurrent callers. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private readonly cwd: string;
  private lastVerify = 0;
  /**
   * Set while a JOB is running and its session has not opened yet — the window in which the root must not be
   * touched. Not derived from the directory: a person typing `/remember` in chat is writing to the project on
   * purpose, and that is the feature. This is only about what a run does as a SIDE EFFECT.
   */
  private deferred = false;
  /**
   * Entries learned before a session existed, held until one does.
   *
   * The store is built when the process starts, and the only directory it can be given then is the PROJECT.
   * Refining, sizing and triage all run in that window and all can learn something. Writing it at the root
   * is what left `memory.jsonl` modified there for every later merge to trip over; dropping it would lose
   * the lessons those phases paid for. So it waits, and lands in the session the moment one opens.
   */
  private pending: MemoryEntry[] = [];
  private candidates: string[] = []; // ids the last hygiene run put up for review

  constructor(opts: MemoryStoreOpts) {
    this.now = opts.now ?? ((): number => Date.now());
    this.cwd = opts.cwd;
    /**
     * Memory belongs to the SESSION, and there is exactly one copy of it per session.
     *
     * A task worktree that kept its own would have to merge it back through its branch — and with dozens of
     * tasks all touching one line-based file, every task becomes a conflict. Resolving to the session base
     * instead gives one file and one writer, and that file is the base the pull request is cut from, so a
     * lesson a task learned is delivered with the work rather than left in a directory nobody reads.
     */
    this.file = join(stateRoot(opts.cwd), ".horsecode", "memory.jsonl");
  }

  /**
   * Hold everything learned from here until a session exists.
   *
   * Called when a job starts, because refining, sizing and triage all run before the worktree is opened and
   * all can learn something. Writing it at the root left `memory.jsonl` modified in the project checkout —
   * one of four files (with `graphify-out/` and the traces) that both sides of a merge regenerate, so every
   * later pull refused to apply. Dropping it instead would lose what those phases paid for.
   */
  deferUntilSession(): void {
    this.deferred = writableStateRoot(this.cwd) === undefined;
  }

  /**
   * Points the store at a session's base worktree, or back at the project when the session ends.
   *
   * `stateRoot` resolves the right file for a given directory — but the store is built once, when the
   * process starts, and the only directory it can be given then is the PROJECT. A session opens later, so
   * the path computed in the constructor stayed the project's for the whole run.
   *
   * Measured on a real job: the session's inherited `memory.jsonl` was never written after the moment it was
   * copied, while the project's gained 26 uses and 85 injections during the same hour. Everything the run
   * learned landed in the reference copy and outside the pull request — the opposite of the rule that the
   * root is read, and the session is what ships.
   *
   * The cache is dropped rather than carried across: the two files are separate records, and keeping entries
   * loaded from one while writing to the other is how a session would overwrite the project's memory with a
   * stale snapshot of itself.
   */
  retarget(cwd: string): void {
    const next = join(stateRoot(cwd), ".horsecode", "memory.jsonl");
    if (next === this.file) return;
    this.file = next;
    if (writableStateRoot(cwd) !== undefined) this.deferred = false;  // …the session is here; the wait is over
    this.cache = undefined;
  }

  /** Where entries are being written right now — for tests, and for anything that reports on state. */
  filePath(): string { return this.file; }

  /** Project-relative content fingerprint, used to detect that an anchored file moved on. */
  private readonly anchorFs: AnchorFs = {
    fingerprint: (rel: string): string | undefined => {
      try {
        const abs = join(this.cwd, rel);
        const st = statSync(abs);
        if (!st.isFile()) return undefined;
        if (st.size > HASH_MAX_BYTES) return `s${st.size}:${Math.floor(st.mtimeMs)}`;
        return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
      } catch {
        return undefined; // missing/unreadable → the anchor no longer verifies
      }
    },
  };

  /**
   * Re-checks every entry's file anchors and flags the ones whose anchored code changed. Throttled: retrieval
   * asks for `all()` on every turn, and re-hashing on each call would be pure waste.
   */
  verify(force = false): void {
    if (!this.cache) return;
    const t = this.now();
    if (!force && t - this.lastVerify < 2000) return;
    this.lastVerify = t;
    for (const e of this.cache) {
      const fresh = verifyAnchors(e, this.anchorFs);
      if (e.stale !== !fresh) e.stale = !fresh; // flag only; the entry is kept (the file may come back)
    }
  }

  /** Load entries from disk (memoized). Corrupt lines are skipped. */
  async load(): Promise<MemoryEntry[]> {
    if (this.cache) return this.cache;
    const out: MemoryEntry[] = [];
    try {
      const raw = await readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as MemoryEntry); } catch { /* skip a corrupt line */ }
      }
    } catch {
      /* no memory file yet */
    }
    this.cache = out;
    /**
     * What was learned before the session existed lands here, once, the first time the session's file is read.
     *
     * Ids are re-minted against what the session already holds: the two files were written independently, so
     * a timestamp id from the project window can collide with one the session inherited.
     */
    if (!this.deferred && this.pending.length) {
      for (const e of this.pending) out.push({ ...e, id: this.mintId() });
      this.pending = [];
      await this.persist();
    }
    // An already-written file is repaired once, on the way in. Both repairs are pure re-derivations, so a
    // healthy file is left byte-for-byte alone.
    const repaired = this.dedupeIds(out);
    const retagged = this.retag(out);
    if (repaired || retagged) await this.persist();
    return out;
  }

  /**
   * Re-derives tags for entries written under an older rule.
   *
   * Tags are stored, so fixing how they are derived does nothing for memories already on disk — and the rule
   * that was fixed had been dropping the meaningful words: a fact about `DomainException` kept `types`,
   * `must` and `including` while losing `domain` and `exception`, which is what a query would have matched.
   * On the real pool that entry scored ZERO for the question it was written to answer.
   *
   * `deriveTags` is pure, so recomputing is safe and idempotent: an entry already tagged correctly produces
   * exactly what it has. Returns whether anything changed.
   */
  private retag(entries: MemoryEntry[]): boolean {
    let changed = false;
    for (const e of entries) {
      const fresh = deriveTags(e.text, e.anchors ?? []);
      if (fresh.length === e.tags?.length && fresh.every((t, i) => e.tags[i] === t)) continue;
      e.tags = fresh;
      changed = true;
    }
    return changed;
  }

  /**
   * Gives a fresh id to every entry that shares one, keeping the first.
   *
   * Files written before ids were minted uniquely already carry collisions — the real one measured 1471
   * entries under 1344 ids — and nothing downstream can tell those rows apart: every consumer resolves an id
   * with `find`, which returns the first match. Repairing on load fixes them without asking the user to
   * notice a problem they cannot see.
   *
   * Returns whether anything changed, so a healthy file is never rewritten.
   */
  private dedupeIds(entries: MemoryEntry[]): boolean {
    const seen = new Set<string>();
    let changed = false;
    for (const e of entries) {
      if (!seen.has(e.id)) { seen.add(e.id); continue; }
      let id = `${e.id}-2`;
      for (let n = 3; seen.has(id); n++) id = `${e.id}-${n}`;
      e.id = id;
      seen.add(id);
      changed = true;
    }
    return changed;
  }

  /**
   * Synchronous snapshot of the entries — LOADING them if nobody has yet.
   *
   * It used to be `this.cache ?? []`, which is a snapshot of whatever happened to have been read already, and
   * `retarget` — the very call that points the store at a newly opened session — ends by clearing the cache.
   * So from the moment a session opened, every retrieval saw an empty store, for the rest of the run.
   *
   * It was invisible for three runs because it looks exactly like a project with nothing worth recalling: the
   * start-up banner said "746 entries" (read before the session existed), the file on disk had all of them,
   * selection returned five hits when run by hand against the same file, and the injector reported nothing.
   * What finally named it was recording the MISS: `reason: empty-store, available: 0` on a role whose store
   * demonstrably had 721 selectable entries.
   *
   * Synchronous because every caller is: retrieval happens while a prompt is being assembled, and an `async`
   * load there would mean changing every role's assembly for a file read that takes under a millisecond.
   */
  all(): MemoryEntry[] {
    if (!this.cache) this.loadSync();
    this.verify(); // a memory whose anchored file changed must not be injected as if still true
    return this.cache ?? [];
  }

  /**
   * The same read as {@link load}, without awaiting.
   *
   * Deliberately does NOT do `load`'s extra work — adopting `pending` entries and re-minting their ids writes
   * to disk, and a read must not. Those still land through `load`, which every write path already awaits.
   */
  private loadSync(): void {
    const out: MemoryEntry[] = [];
    try {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as MemoryEntry); } catch { /* skip a corrupt line */ }
      }
    } catch {
      /* no memory file yet — an empty store is the honest answer */
    }
    this.cache = out;
  }

  /**
   * Drops entries past their hard expiry. `permanent` is exempt by definition; everything else only expires if
   * it was given an explicit TTL, so nothing silently disappears that was not marked short-lived.
   */
  async pruneExpired(): Promise<number> {
    return this.serialize(async () => {
      await this.load();
      const now = this.now();
      const before = this.cache!.length;
      this.cache = this.cache!.filter((e) => !isExpired(e, now));
      const dropped = before - this.cache.length;
      if (dropped > 0) await this.persist();
      return dropped;
    });
  }

  /**
   * Reconciles the pool: merges duplicates and returns the entries now up for review. Never deletes — a wrong
   * automatic deletion is unrecoverable here (the file is the only copy), so questionable entries are only
   * flagged. Runs once per session and on demand.
   */
  async runHygiene(opts?: { provider: Provider; models: string[]; signal?: AbortSignal }): Promise<HygieneReport> {
    return this.serialize(async () => {
      await this.load();
      this.verify(true); // fresh staleness flags first — "long-stale" is one of the review reasons
      const report = hygiene(this.cache!, this.now());
      let entries = report.entries;
      let semantic = 0;
      /**
       * Then the duplicates that only a reader can see.
       *
       * `hygiene` collapses entries whose text normalizes alike; parallel work produces the other kind — two
       * tasks discovering the same thing and writing it in their own words, which no string comparison
       * catches. Optional because it costs a model call: without a provider the pool is still reconciled,
       * just not as far.
       */
      if (opts) {
        const merges = await dedupeMemories({ ...opts, entries });
        const applied = applyMerges(entries, merges);
        entries = applied.entries;
        semantic = applied.removed;
      }
      if (report.merged.length || semantic > 0) {
        this.cache = entries;
        await this.persist();
      }
      this.candidates = report.candidates.map((c) => c.id);
      return { ...report, entries, semanticMerged: semantic };
    });
  }

  /** Ids flagged by the last hygiene run — surfaced by /memories next to the lifecycle state. */
  reviewCandidates(): string[] {
    return [...this.candidates];
  }

  /**
   * Records that these memories were put into a prompt. Without the count there is no way to tell a memory that
   * is genuinely never relevant from one that has simply never come up — and the first should stop winning slots.
   */
  async recordInjection(ids: string[]): Promise<void> {
    if (!ids.length) return;
    return this.serialize(async () => {
      await this.load();
      let touched = false;
      for (const id of ids) {
        const e = this.cache!.find((m) => m.id === id);
        if (!e) continue;
        e.injections = (e.injections ?? 0) + 1;
        // Every consumer — coach, reviewers, council, judge and now the implementer — reports usage, so an
        // injection recorded from here on is one a memory can be fairly judged on.
        e.observedInjections = (e.observedInjections ?? 0) + 1;
        touched = true;
      }
      if (touched) await this.persist();
    });
  }

  /** Entries currently flagged stale — surfaced by /memory so the user can re-confirm or delete them. */
  stale(): MemoryEntry[] {
    this.verify();
    return (this.cache ?? []).filter((e) => e.stale);
  }

  /**
   * A NEW id, unique against everything already held.
   *
   * The id used to be the millisecond clock alone, which is unique only while writes are seconds apart. A
   * migration importing 1878 facts in one loop put several into the same millisecond: measured on the real
   * file, 1471 entries carried 1344 distinct ids — 101 ids shared by up to five entries each.
   *
   * That is not cosmetic. Every consumer resolves an id with `find`, which returns the FIRST match: a use
   * credited to one memory lands on another, an injection is counted against the wrong entry, and `/forget`
   * deletes a memory the user was not looking at. The whole usage record silently describes the wrong rows.
   */
  private mintId(): string {
    const stamp = this.now();
    const taken = new Set((this.cache ?? []).map((e) => e.id));
    let id = `m${stamp}`;
    for (let n = 2; taken.has(id); n++) id = `m${stamp}-${n}`;
    return id;
  }

  private async persist(): Promise<void> {
    // Mid-job, before the session opens: the root is read, never written. It waits in `pending`.
    if (this.deferred) return;
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    /**
     * Keep the machine-local state out of git; memory.jsonl and the installed skills are shared.
     *
     * `last-turn.json` is the newest entry and the one most easily missed: it carries a COPY of what the
     * previous turn overwrote, so it is both machine-local and, on a project with private files, a second
     * place their contents could reach a remote. It exists to answer "undo that" in this checkout, and it
     * has no meaning in anyone else's.
     */
    const gi = join(dir, ".gitignore");
    if (!existsSync(gi)) {
      await writeFile(gi, "# horse-code: local state stays out of git; memory.jsonl + skills are shared\n"
        + "config.json\nsources.json\nworktrees/\nlast-turn.json\n", "utf8");
    }
    /**
     * Two sessions that both learn something must not have to fight over this file.
     *
     * It is one JSON object per line and entries are only ever added, so the two sides of a merge are two
     * sets of lines — `union` keeps both instead of raising a conflict on a file no human wants to resolve
     * by hand. What union cannot do is notice that the two sides said the SAME thing in different words;
     * that is what the dedupe pass is for, and it runs after the merge, not instead of it.
     */
    const ga = join(dir, ".gitattributes");
    if (!existsSync(ga)) {
      await writeFile(ga, "# Append-only: keep both sides of a merge, then let the dedupe pass reconcile them.\nmemory.jsonl merge=union\n", "utf8");
    }
    // Atomic: a crash mid-write must not leave an empty memory. See writeAtomic — this file was lost that way.
    await writeAtomic(this.file, (this.cache ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /**
   * Remember a fact (anchors/tags auto-derived). A new fact that supersedes existing same-topic facts
   * replaces them (returned in `superseded`) so contradictions don't accumulate.
   */
  async add(
    text: string,
    kind: "fact" | "lesson" | "rule" = "fact",
    opts: {
      audience?: string[]; learnedBy?: string; persistence?: "permanent" | "long" | "short";
      /** Only set by non-user writers (the auto-extractor): the defaults already encode "the user said so". */
      importance?: number; confidence?: number;
    } = {},
  ): Promise<{ ok: true; entry: MemoryEntry; superseded: string[] } | { ok: false; error: string }> {
    return this.serialize(async () => {
      await this.load();
      const t = text.trim();
      if (!t) return { ok: false as const, error: "empty memory" };
      if (this.cache!.some((e) => e.text === t)) return { ok: false as const, error: "already remembered" };
      const anchors = deriveAnchors(t);
      const hashes = hashAnchors(anchors, this.anchorFs); // fingerprint the code this claim is ABOUT
      // A rule is a standing directive → permanent by default. Everything else is long-lived unless the caller
      // says it is short-lived scaffolding, which then carries a hard TTL.
      const persistence = opts.persistence ?? (kind === "rule" ? "permanent" : "long");
      const entry: MemoryEntry = {
        id: this.mintId(), text: t, anchors, tags: deriveTags(t, anchors), createdAt: this.now(), uses: 0, kind,
        persistence,
        ...(persistence === "short" ? { expiresAt: this.now() + SHORT_TTL_MS } : {}),
        ...(opts.audience?.length ? { audience: opts.audience } : {}),
        ...(opts.learnedBy ? { learnedBy: opts.learnedBy } : {}),
        // Stored only when the writer states them: an absent field means "the defaults for this kind apply",
        // which is exactly right for a memory the user dictated.
        ...(opts.importance !== undefined ? { importance: opts.importance } : {}),
        ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
        ...(Object.keys(hashes).length ? { anchorHashes: hashes } : {}),
      };
      // A new entry supersedes only same-kind, same-topic ones (a fact never replaces a lesson, or vice versa).
      const sameKind = (e: MemoryEntry): boolean => (e.kind ?? "fact") === kind;
      const superseded = this.cache!.filter((e) => sameKind(e) && supersedes(entry, e)).map((e) => e.text);
      this.cache = this.cache!.filter((e) => !(sameKind(e) && supersedes(entry, e)));
      this.cache.push(entry);
      if (this.deferred) this.pending.push(entry);  // …no session yet: it waits rather than dirtying the root
      await this.persist();
      return { ok: true as const, entry, superseded };
    });
  }

  /** Reinforce a memory the model actually cited (bumps its use count → ranks higher on future ties). */
  async reinforce(id: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      const e = this.cache!.find((m) => m.id === id);
      if (!e) return;
      e.uses = (e.uses ?? 0) + 1;
      await this.persist();
    });
  }

  /** Forget the 1-based N-th memory. Returns the removed entry text, or undefined if out of range. */
  async remove(n: number): Promise<string | undefined> {
    return this.serialize(async () => {
      await this.load();
      if (n < 1 || n > this.cache!.length) return undefined;
      const [removed] = this.cache!.splice(n - 1, 1);
      await this.persist();
      return removed.text;
    });
  }
}
