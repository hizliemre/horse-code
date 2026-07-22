import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { deriveAnchors, deriveTags, type MemoryEntry } from "../engine/memory-retrieval.js";

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

  /** Remember a fact (anchors/tags auto-derived). Returns the new entry, or an error string. */
  async add(text: string): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }> {
    await this.load();
    const t = text.trim();
    if (!t) return { ok: false, error: "empty memory" };
    if (this.cache!.some((e) => e.text === t)) return { ok: false, error: "already remembered" };
    const anchors = deriveAnchors(t);
    const entry: MemoryEntry = { id: `m${this.now()}`, text: t, anchors, tags: deriveTags(t, anchors), createdAt: this.now() };
    this.cache!.push(entry);
    await this.persist();
    return { ok: true, entry };
  }

  /** Forget the 1-based N-th memory. Returns the removed entry text, or undefined if out of range. */
  async remove(n: number): Promise<string | undefined> {
    await this.load();
    if (n < 1 || n > this.cache!.length) return undefined;
    const [removed] = this.cache!.splice(n - 1, 1);
    await this.persist();
    return removed.text;
  }
}
