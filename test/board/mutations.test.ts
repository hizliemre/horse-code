import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

function seeded(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "a" });
  return b;
}

describe("Board mutations", () => {
  it("move changes the column; adds a stage event when an actor is given", () => {
    const b = seeded();
    b.move("t1", "IN-PROGRESS", "team-lead");
    const c = b.get("t1")!;
    expect(c.column).toBe("IN-PROGRESS");
    expect(c.stageHistory).toEqual([{ role: "team-lead", action: "→IN-PROGRESS" }]);
  });

  it("move without an actor doesn't add a stage event", () => {
    const b = seeded();
    b.move("t1", "REVIEW");
    expect(b.get("t1")!.stageHistory).toEqual([]);
    expect(b.get("t1")!.column).toBe("REVIEW");
  });

  it("appendStage adds a rich event", () => {
    const b = seeded();
    b.appendStage("t1", { role: "code-reviewer", action: "reviewed:fail", note: "x" });
    expect(b.get("t1")!.stageHistory).toEqual([
      { role: "code-reviewer", action: "reviewed:fail", note: "x" },
    ]);
  });

  it("addReviewNote / clearReviewNotes", () => {
    const b = seeded();
    b.addReviewNote("t1", "n1");
    b.addReviewNote("t1", "n2");
    expect(b.get("t1")!.reviewNotes).toEqual(["n1", "n2"]);
    b.clearReviewNotes("t1");
    expect(b.get("t1")!.reviewNotes).toEqual([]);
  });

  it("incrementAttempts returns the new value", () => {
    const b = seeded();
    expect(b.incrementAttempts("t1")).toBe(1);
    expect(b.incrementAttempts("t1")).toBe(2);
    expect(b.get("t1")!.attempts).toBe(2);
  });

  it("setWorktree sets the path", () => {
    const b = seeded();
    b.setWorktree("t1", "/wt/t1");
    expect(b.get("t1")!.worktree).toBe("/wt/t1");
  });

  it("unknown id causes every mutation to throw", () => {
    const b = seeded();
    expect(() => b.move("missing", "DONE")).toThrow(/unknown card/);
    expect(() => b.appendStage("missing", { role: "r", action: "a" })).toThrow(/unknown card/);
    expect(() => b.addReviewNote("missing", "n")).toThrow(/unknown card/);
    expect(() => b.clearReviewNotes("missing")).toThrow(/unknown card/);
    expect(() => b.incrementAttempts("missing")).toThrow(/unknown card/);
    expect(() => b.setWorktree("missing", "/p")).toThrow(/unknown card/);
  });
});
