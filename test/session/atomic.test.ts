import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, writeAtomicSync } from "../../src/session/atomic.js";
import { MemoryStore } from "../../src/session/memory.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-atomic-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * `writeFile` truncates before it writes, so a process that dies mid-write leaves NOTHING. A real project's
 * memory.jsonl went from 1471 entries to a 0-byte file the moment its process exited — not in git, no
 * backup, three quarters of a million tokens to rebuild.
 */
describe("atomic writes", () => {
  it("replaces the file and leaves no temporary behind", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "first");
    await writeAtomic(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the PREVIOUS content when the new write never completes", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "the good state");
    // A crash between writing the temp file and renaming it: the temp exists, the target is untouched.
    await writeFile(`${path}.tmp`, "half a write", "utf8");
    expect(await readFile(path, "utf8")).toBe("the good state");
  });

  it("does the same synchronously, for callers that cannot await", () => {
    const path = join(dir, "sync.json");
    writeAtomicSync(path, "written");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("never leaves the memory file empty across a rewrite", async () => {
    const s = new MemoryStore({ home: dir, cwd: join(dir, "proj") });
    for (const t of ["one fact", "another fact", "a third fact"]) await s.add(t);
    const file = join(dir, "proj", ".horsecode", "memory.jsonl");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(3);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
