import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

  it("loadBoard throws for a nonexistent file", async () => {
    await expect(loadBoard(join(dir, "missing.json"))).rejects.toThrow();
  });
});
