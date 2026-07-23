import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { deriveAnchors, deriveTags, supersedes, type MemoryEntry } from "../engine/memory-retrieval.js";

export interface MemoryStoreOpts {
  home: string;
  cwd: string;
  now?: () => number;
}

/**
 * Per-project cross-session memory: durable facts the user asks to remember, retrieved lexically and
 * injected into later turns. Stored as JSONL at ~/.horsecode/projects/<hash(cwd)>/memory.jsonl.
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

  constructor(opts: MemoryStoreOpts) {
    this.now = opts.now ?? ((): number => Date.now());
    const hash = createHash("sha256").update(opts.cwd).digest("hex").slice(0, 16);
    this.file = join(opts.home, ".horsecode", "projects", hash, "memory.jsonl");
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
    return out;
  }

  /** Synchronous snapshot of the loaded entries (for the retrieval injector). */
  all(): MemoryEntry[] {
    return this.cache ?? [];
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, (this.cache ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  /**
   * Remember a fact (anchors/tags auto-derived). A new fact that supersedes existing same-topic facts
   * replaces them (returned in `superseded`) so contradictions don't accumulate.
   */
  async add(text: string, kind: "fact" | "lesson" = "fact"): Promise<{ ok: true; entry: MemoryEntry; superseded: string[] } | { ok: false; error: string }> {
    return this.serialize(async () => {
      await this.load();
      const t = text.trim();
      if (!t) return { ok: false as const, error: "empty memory" };
      if (this.cache!.some((e) => e.text === t)) return { ok: false as const, error: "already remembered" };
      const anchors = deriveAnchors(t);
      const entry: MemoryEntry = { id: `m${this.now()}`, text: t, anchors, tags: deriveTags(t, anchors), createdAt: this.now(), uses: 0, kind };
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
