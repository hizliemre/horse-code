import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../../src/board/board.js";
import { saveBoard, loadBoard } from "../../src/board/persist.js";

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
