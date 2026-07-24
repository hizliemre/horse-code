import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

describe("Board core", () => {
  it("addCard adds a new card in TODO with attempts 0 and empty arrays", () => {
    const b = new Board();
    const c = b.addCard({ id: "t1", title: "ilk", deps: ["x"] });
    expect(c).toEqual({
      id: "t1", title: "ilk", column: "TODO",
      deps: ["x"], reviewNotes: [], attempts: 0, stageHistory: [],
    });
  });

  it("same id a second time → error", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    expect(() => b.addCard({ id: "t1", title: "b" })).toThrow(/already exists/);
  });

  it("get returns undefined for an unknown id", () => {
    expect(new Board().get("missing")).toBeUndefined();
  });

  it("list preserves insertion order; byColumn filters", () => {
    const b = new Board();
    b.addCard({ id: "a", title: "a" });
    b.addCard({ id: "b", title: "b" });
    expect(b.list().map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("TODO").map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("DONE")).toEqual([]);
  });

  it("get returns a defensive copy (external mutation doesn't corrupt internal state)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    const c = b.get("t1")!;
    c.reviewNotes.push("external");
    c.column = "DONE";
    expect(b.get("t1")!.reviewNotes).toEqual([]);
    expect(b.get("t1")!.column).toBe("TODO");
  });

  it("onChange is called on every mutation", () => {
    const b = new Board();
    let calls = 0;
    b.onChange = () => { calls++; };
    b.addCard({ id: "t1", title: "X" });               // 1
    b.move("t1", "IN-PROGRESS");                        // 2
    b.appendStage("t1", { role: "r", action: "a" });   // 3
    b.addReviewNote("t1", "n");                         // 4
    b.clearReviewNotes("t1");                           // 5
    b.incrementAttempts("t1");                          // 6
    b.setWorktree("t1", "/w");                          // 7
    expect(calls).toBe(7);
  });

  it("onChange being unset doesn't break mutations (backward compatible)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "X" });
    b.move("t1", "DONE");
    expect(b.get("t1")!.column).toBe("DONE");
  });

  it("onMove fires only on a REAL column transition, with from/to (drives chat action notes)", () => {
    const b = new Board();
    const moves: { title: string; from: string; to: string }[] = [];
    b.onMove = (card, from, to) => moves.push({ title: card.title, from, to });
    b.addCard({ id: "t1", title: "X" });    // addCard → not a move, no onMove
    b.move("t1", "IN-PROGRESS");
    b.move("t1", "IN-PROGRESS");             // same column → NOT a transition, no onMove
    b.move("t1", "REVIEW");
    b.move("t1", "DONE");
    expect(moves).toEqual([
      { title: "X", from: "TODO", to: "IN-PROGRESS" },
      { title: "X", from: "IN-PROGRESS", to: "REVIEW" },
      { title: "X", from: "REVIEW", to: "DONE" },
    ]);
  });
});
