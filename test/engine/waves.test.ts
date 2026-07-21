import { describe, it, expect } from "vitest";
import { computeWaves, validateWaves } from "../../src/engine/waves.js";
import { Board } from "../../src/board/board.js";

function board(cards: { id: string; deps?: string[] }[]): Board {
  const b = new Board();
  for (const c of cards) b.addCard({ id: c.id, title: c.id, deps: c.deps });
  return b;
}

describe("computeWaves", () => {
  it("independent cards in the same wave", () => {
    expect(computeWaves(board([{ id: "a" }, { id: "b" }]))).toEqual([["a", "b"]]);
  });
  it("chain → sequential waves", () => {
    const b = board([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
    expect(computeWaves(b)).toEqual([["a"], ["b"], ["c"]]);
  });
  it("diamond: a → {b,c} → d", () => {
    const b = board([
      { id: "a" },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ]);
    expect(computeWaves(b)).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("cycle → error", () => {
    const b = board([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]);
    expect(() => computeWaves(b)).toThrow(/cycle|unresolved/);
  });
  it("empty board → empty waves", () => {
    expect(computeWaves(new Board())).toEqual([]);
  });
});

describe("validateWaves", () => {
  const chain = () => board([{ id: "a" }, { id: "b", deps: ["a"] }]);
  it("valid waves → true", () => {
    expect(validateWaves([["a"], ["b"]], chain())).toBe(true);
  });
  it("dep in the same wave → false", () => {
    expect(validateWaves([["a", "b"]], chain())).toBe(false);
  });
  it("missing/duplicate card → false", () => {
    expect(validateWaves([["a"]], chain())).toBe(false); // b missing
    expect(validateWaves([["a"], ["b"], ["a"]], chain())).toBe(false); // a duplicated
  });
});
