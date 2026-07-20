import { describe, it, expect } from "vitest";
import { computeWaves, validateWaves } from "../../src/engine/waves.js";
import { Board } from "../../src/board/board.js";

function board(cards: { id: string; deps?: string[] }[]): Board {
  const b = new Board();
  for (const c of cards) b.addCard({ id: c.id, title: c.id, deps: c.deps });
  return b;
}

describe("computeWaves", () => {
  it("bağımsız kartlar aynı dalgada", () => {
    expect(computeWaves(board([{ id: "a" }, { id: "b" }]))).toEqual([["a", "b"]]);
  });
  it("zincir sıralı dalgalar", () => {
    const b = board([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
    expect(computeWaves(b)).toEqual([["a"], ["b"], ["c"]]);
  });
  it("elmas: a → {b,c} → d", () => {
    const b = board([
      { id: "a" },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ]);
    expect(computeWaves(b)).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("döngü → hata", () => {
    const b = board([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]);
    expect(() => computeWaves(b)).toThrow(/döngü|çözülemeyen/);
  });
  it("boş board → boş dalgalar", () => {
    expect(computeWaves(new Board())).toEqual([]);
  });
});

describe("validateWaves", () => {
  const chain = () => board([{ id: "a" }, { id: "b", deps: ["a"] }]);
  it("geçerli dalgalar → true", () => {
    expect(validateWaves([["a"], ["b"]], chain())).toBe(true);
  });
  it("dep aynı dalgada → false", () => {
    expect(validateWaves([["a", "b"]], chain())).toBe(false);
  });
  it("eksik/tekrar kart → false", () => {
    expect(validateWaves([["a"]], chain())).toBe(false); // b eksik
    expect(validateWaves([["a"], ["b"], ["a"]], chain())).toBe(false); // a tekrar
  });
});
