import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../../src/board/board.js";
import { saveBoard, loadBoard, flushBoard } from "../../src/board/persist.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-board-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("board persistence", () => {
  it("saveBoard creates parent directories and loadBoard returns the same board", async () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", deps: ["x"] });
    b.move("t1", "REVIEW", "coder");
    b.addReviewNote("t1", "n");
    const path = join(dir, "sessions", "s1", "board.json"); // parent directories don't exist yet
    await saveBoard(b, path);
    expect(existsSync(path)).toBe(true);
    const back = await loadBoard(path);
    expect(back.list()).toEqual(b.list());
  });

  it("round-trips the file list a card was created with", async () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", files: ["src/a.ts"] });
    const path = join(dir, "board.json");
    await saveBoard(b, path);
    expect((await loadBoard(path)).get("t1")!.files).toEqual(["src/a.ts"]);
  });

  /** A run interrupted before file lists existed must still resume — its board has no `files` key at all. */
  it("loads a board written before cards had file lists", async () => {
    const path = join(dir, "old.json");
    await writeFile(path, JSON.stringify({ version: 1, cards: [
      { id: "t1", title: "a", column: "TODO", deps: [], reviewNotes: [], attempts: 0, stageHistory: [] },
    ] }));
    expect((await loadBoard(path)).get("t1")!.files).toEqual([]);
  });

  it("loadBoard throws for a nonexistent file", async () => {
    await expect(loadBoard(join(dir, "missing.json"))).rejects.toThrow();
  });
});

/**
 * A card left mid-flight by a run that died is not in progress — the process took its workers with it.
 *
 * Left as they were, the agent panel listed four implementers that did not exist, with no role and no model,
 * their clocks counting up from the moment the panel first saw them.
 */
describe("reopening an interrupted card", () => {
  it("returns it to TODO and forgets who was working it", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    b.move("t1", "IN-PROGRESS", "coder");
    b.setWorker("t1", "coder", "cc/opus");
    b.reopen("t1");
    const c = b.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.role).toBeUndefined();
    expect(c.model).toBeUndefined();
  });

  /** Nothing happened to this task; a process died. The chat must not report a transition nobody performed. */
  it("does not narrate the move", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    b.move("t1", "IN-PROGRESS", "coder");
    const moves: string[] = [];
    b.onMove = (_c, _f, to) => moves.push(to);
    b.reopen("t1");
    expect(moves).toEqual([]);
  });

  it("keeps the work already recorded on the card", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", acceptance: ["x"], files: ["src/a.ts"] });
    b.move("t1", "IN-PROGRESS", "coder");
    b.addReviewNote("t1", "fix the thing");
    b.reopen("t1");
    expect(b.get("t1")!.reviewNotes).toEqual(["fix the thing"]);
    expect(b.get("t1")!.acceptance).toEqual(["x"]);
  });
});

/**
 * Splitting DONE (reviewed) from MERGED (in the base branch) changed what a PERSISTED column means, and an
 * old board says DONE for work that really is delivered. Read literally, a real board came back with 69 DONE,
 * one MERGED and 24 tasks that could never start — their dependencies were all in that 69 — so the run
 * collapsed to one task at a time, redoing finished work.
 */
describe("a board written before MERGED existed", () => {
  const old = (cards: unknown[]): string => JSON.stringify({ version: 1, cards });
  const card = (id: string, column: string, history: { role: string; action: string }[]) => ({
    id, title: id, column, deps: [], reviewNotes: [], attempts: 1, stageHistory: history,
  });

  it("reads a DONE card that git merged as MERGED", async () => {
    const path = join(dir, "old.json");
    await writeFile(path, old([card("t1", "DONE", [{ role: "team-lead", action: "merged" }])]));
    expect((await loadBoard(path)).get("t1")!.column).toBe("MERGED");
  });

  /** DONE without a merge event is exactly what DONE now means: reviewed, never landed, worth retrying. */
  it("leaves a DONE card that never merged in DONE", async () => {
    const path = join(dir, "old.json");
    await writeFile(path, old([card("t1", "DONE", [{ role: "team-lead", action: "merge-conflict" }])]));
    expect((await loadBoard(path)).get("t1")!.column).toBe("DONE");
  });

  it("does not touch the other columns", async () => {
    const path = join(dir, "old.json");
    await writeFile(path, old([
      card("a", "TODO", []), card("b", "REVIEW", []), card("c", "IN-PROGRESS", []),
      card("d", "MERGED", [{ role: "team-lead", action: "merged" }]),
    ]));
    const b = await loadBoard(path);
    expect(["a", "b", "c", "d"].map((i) => b.get(i)!.column)).toEqual(["TODO", "REVIEW", "IN-PROGRESS", "MERGED"]);
  });
});

/**
 * The board is rewritten on EVERY mutation from a fire-and-forget handler, while the wave engine mutates it
 * from several tasks at once. Nothing serialised those writes: two overlapping `writeFile` calls each
 * truncated the file and wrote from their own offset, so the longer one's tail outlived the shorter one's end.
 *
 * Found in the wild: a 95-card board holding a complete valid document followed by 2056 bytes of the previous,
 * longer version, beginning mid-sentence. It parsed as "Extra data" and would have taken the next run's
 * resume with it — this file is the only record of which tasks are already merged.
 */
describe("concurrent saves cannot tear the board", () => {
  const bigBoard = (cards: number, noteLen: number): Board => {
    const b = new Board();
    for (let i = 0; i < cards; i++) {
      b.addCard({ id: `t${i}`, title: `task ${i}` });
      b.addReviewNote(`t${i}`, "x".repeat(noteLen));
    }
    return b;
  };

  it("leaves a file that is exactly the JSON, with no tail of a longer previous write", async () => {
    const path = join(dir, "board.json");
    // A large board first, then a much smaller one — the shrink is what exposed the old bug.
    await saveBoard(bigBoard(300, 4000), path);
    const small = bigBoard(3, 10);
    await Promise.all(Array.from({ length: 25 }, () => saveBoard(small, path)));

    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    // The precise signature of the corruption: valid JSON, then bytes past its end.
    expect(raw.length).toBe(JSON.stringify(small.toJSON(), null, 2).length);
    expect((await loadBoard(path)).list()).toHaveLength(3);
  });

  it("writes the newest state even when a burst is collapsed into one write", async () => {
    const path = join(dir, "board.json");
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    const writes = [];
    for (const col of ["REVIEW", "DONE", "MERGED"] as const) {
      b.move("t1", col, "coder");
      writes.push(saveBoard(b, path));
    }
    await Promise.all(writes);
    expect((await loadBoard(path)).get("t1")!.column).toBe("MERGED");
  });

  it("survives a burst of near-identical snapshots — the shape that actually tore", async () => {
    /**
     * Two SUCCESSIVE board snapshots differ by very little; the corrupt board differed from its predecessor
     * by 2056 bytes. Reproduced against the old unserialised write, that shape tore in 23 of 40 rounds, while
     * writing a big document followed by a tiny one never tore at all — the near-equal sizes are the point.
     */
    const path = join(dir, "board.json");
    const a = bigBoard(660, 4000);
    const b = bigBoard(659, 4000);
    for (let round = 0; round < 8; round++) {
      await Promise.all([saveBoard(a, path), saveBoard(b, path), saveBoard(a, path), saveBoard(b, path)]);
      const raw = await readFile(path, "utf8");
      expect(() => JSON.parse(raw) as unknown).not.toThrow();
      // Whichever snapshot won, the file is exactly one of them — never one with the other's tail attached.
      expect([JSON.stringify(a.toJSON(), null, 2).length, JSON.stringify(b.toJSON(), null, 2).length])
        .toContain(raw.length);
    }
  });

  it("does not leave its temporary file behind", async () => {
    const path = join(dir, "board.json");
    await Promise.all(Array.from({ length: 10 }, () => saveBoard(bigBoard(20, 100), path)));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("flushBoard", () => {
  it("settles a fire-and-forget save so the file is readable the moment a run returns", async () => {
    const path = join(dir, "board.json");
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    void saveBoard(b, path); // exactly how `board.onChange` saves
    await flushBoard(path);
    expect((await loadBoard(path)).get("t1")!.title).toBe("a");
  });

  it("is a no-op for a board nobody has written", async () => {
    await expect(flushBoard(join(dir, "never.json"))).resolves.toBeUndefined();
  });
});
