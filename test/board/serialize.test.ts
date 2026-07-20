import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

describe("Board serileştirme", () => {
  it("toJSON version + kartları verir", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    b.move("t1", "REVIEW", "coder");
    const data = b.toJSON();
    expect(data.version).toBe(1);
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0].column).toBe("REVIEW");
  });

  it("toJSON → fromJSON round-trip aynı kartları verir", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", deps: ["x"] });
    b.addReviewNote("t1", "n");
    b.incrementAttempts("t1");
    const back = Board.fromJSON(b.toJSON());
    expect(back.list()).toEqual(b.list());
  });

  it("fromJSON geçersiz veride hata verir", () => {
    expect(() => Board.fromJSON({ version: 1, cards: [{ id: "t1" }] })).toThrow();
    expect(() => Board.fromJSON({ version: 2, cards: [] })).toThrow();
    expect(() =>
      Board.fromJSON({ version: 1, cards: [{ id: "a", title: "a", column: "BOGUS", deps: [], reviewNotes: [], attempts: 0, stageHistory: [] }] }),
    ).toThrow();
  });
});
