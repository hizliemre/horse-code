import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomic } from "./atomic.js";
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
  private readonly file: string;
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
  private candidates: string[] = []; // ids the last hygiene run put up for review

  constructor(opts: MemoryStoreOpts) {
    this.now = opts.now ?? ((): number => Date.now());
    this.cwd = opts.cwd;
    this.file = join(opts.cwd, ".horsecode", "memory.jsonl");
  }

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

  /** Synchronous snapshot of the loaded entries (for the retrieval injector). */
  all(): MemoryEntry[] {
    this.verify(); // a memory whose anchored file changed must not be injected as if still true
    return this.cache ?? [];
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
  async runHygiene(): Promise<HygieneReport> {
    return this.serialize(async () => {
      await this.load();
      this.verify(true); // fresh staleness flags first — "long-stale" is one of the review reasons
      const report = hygiene(this.cache!, this.now());
      if (report.merged.length) {
        this.cache = report.entries;
        await this.persist();
      }
      this.candidates = report.candidates.map((c) => c.id);
      return report;
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
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    // Keep the secret-bearing local state out of git, but let memory.jsonl be committed + shared with the team.
    const gi = join(dir, ".gitignore");
    if (!existsSync(gi)) {
      await writeFile(gi, "# horse-code: local/secret state stays out of git; memory.jsonl is shared\nconfig.json\nsources.json\nworktrees/\n", "utf8");
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
