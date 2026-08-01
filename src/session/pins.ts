import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { writeAtomic } from "./atomic.js";

export const MAX_PINS = 20;
export const MAX_PIN_CHARS = 500;

export interface PinStoreOpts {
  home: string; // e.g. os.homedir()
  cwd: string; // project directory → pins are scoped per project
}

/**
 * Per-project "context pins": short facts the user wants honored on every turn (e.g. "use pnpm",
 * "target Node 22"). Stored at ~/.horsecode/projects/<hash(cwd)>/pins.json and injected into the
 * system prompt each request, so they survive context compaction by construction.
 */
export class PinStore {
  private readonly file: string;
  private cache?: string[];

  constructor(opts: PinStoreOpts) {
    const hash = createHash("sha256").update(opts.cwd).digest("hex").slice(0, 16);
    this.file = join(opts.home, ".horsecode", "projects", hash, "pins.json");
  }

  /** Load pins from disk (memoized). Missing/corrupt → empty. */
  async load(): Promise<string[]> {
    if (this.cache) return this.cache;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { pins?: unknown };
      this.cache = Array.isArray(data.pins) ? data.pins.filter((p): p is string => typeof p === "string") : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /** Synchronous view of the last-loaded pins (for the system-prompt injector). */
  list(): string[] {
    return this.cache ?? [];
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeAtomic(this.file, JSON.stringify({ pins: this.cache ?? [] })); // the user typed these; a crash must not eat them
  }

  /** Add a pin (trimmed + length-capped). Returns the new pin, or an error string if rejected. */
  async add(text: string): Promise<{ ok: true; pin: string } | { ok: false; error: string }> {
    await this.load();
    const pin = text.trim().slice(0, MAX_PIN_CHARS);
    if (!pin) return { ok: false, error: "empty pin" };
    if (this.cache!.length >= MAX_PINS) return { ok: false, error: `pin limit reached (${MAX_PINS})` };
    if (this.cache!.includes(pin)) return { ok: false, error: "already pinned" };
    this.cache!.push(pin);
    await this.save();
    return { ok: true, pin };
  }

  /** Remove the 1-based N-th pin. Returns the removed pin, or undefined if out of range. */
  async remove(n: number): Promise<string | undefined> {
    await this.load();
    if (n < 1 || n > this.cache!.length) return undefined;
    const [removed] = this.cache!.splice(n - 1, 1);
    await this.save();
    return removed;
  }
}
