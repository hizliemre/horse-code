import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

function seeded(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "a" });
  return b;
}

describe("Board mutasyonları", () => {
  it("move kolonu değiştirir; actor'lı stage event ekler", () => {
    const b = seeded();
    b.move("t1", "IN-PROGRESS", "team-lead");
    const c = b.get("t1")!;
    expect(c.column).toBe("IN-PROGRESS");
    expect(c.stageHistory).toEqual([{ role: "team-lead", action: "→IN-PROGRESS" }]);
  });

  it("move actor'sız stage event eklemez", () => {
    const b = seeded();
    b.move("t1", "REVIEW");
    expect(b.get("t1")!.stageHistory).toEqual([]);
    expect(b.get("t1")!.column).toBe("REVIEW");
  });

  it("appendStage zengin event ekler", () => {
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

  it("incrementAttempts yeni değeri döner", () => {
    const b = seeded();
    expect(b.incrementAttempts("t1")).toBe(1);
    expect(b.incrementAttempts("t1")).toBe(2);
    expect(b.get("t1")!.attempts).toBe(2);
  });

  it("setWorktree yolu set eder", () => {
    const b = seeded();
    b.setWorktree("t1", "/wt/t1");
    expect(b.get("t1")!.worktree).toBe("/wt/t1");
  });

  it("bilinmeyen id her mutasyonda hata verir", () => {
    const b = seeded();
    expect(() => b.move("yok", "DONE")).toThrow(/bilinmeyen kart/);
    expect(() => b.appendStage("yok", { role: "r", action: "a" })).toThrow(/bilinmeyen kart/);
    expect(() => b.addReviewNote("yok", "n")).toThrow(/bilinmeyen kart/);
    expect(() => b.clearReviewNotes("yok")).toThrow(/bilinmeyen kart/);
    expect(() => b.incrementAttempts("yok")).toThrow(/bilinmeyen kart/);
    expect(() => b.setWorktree("yok", "/p")).toThrow(/bilinmeyen kart/);
  });
});
