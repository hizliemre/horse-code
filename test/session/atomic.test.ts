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

describe("writeAtomic under concurrency — the shape this module exists to prevent", () => {
  /**
   * Six writers is not a stress test, it is the trace runner: TRACE_CONCURRENCY workers all checkpointing the
   * same index. With a shared `<path>.tmp` this failed 20 rounds out of 40, and threw 200 times besides as
   * each rename pulled the scratch file out from under the next.
   */
  it("never publishes a file that will not parse, and never fails a write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-race-"));
    const path = join(dir, "index.json");
    let torn = 0;
    let errors = 0;
    for (let round = 0; round < 40; round++) {
      await Promise.all(Array.from({ length: 6 }, (_, i) =>
        writeAtomic(path, JSON.stringify({ n: i, pad: "x".repeat(20_000 + i * 5_000) }))
          .catch(() => { errors++; })));
      try { JSON.parse(await readFile(path, "utf8")); } catch { torn++; }
    }
    expect({ torn, errors }).toEqual({ torn: 0, errors: 0 });
  });

  it("leaves no scratch behind — traces live in a committed directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-scratch-"));
    const path = join(dir, "index.json");
    await Promise.all(Array.from({ length: 6 }, (_, i) => writeAtomic(path, `{"n":${i}}`)));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
