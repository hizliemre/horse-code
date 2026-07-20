import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

describe("Board çekirdek", () => {
  it("addCard yeni kartı TODO'da, attempts 0, boş dizilerle ekler", () => {
    const b = new Board();
    const c = b.addCard({ id: "t1", title: "ilk", deps: ["x"] });
    expect(c).toEqual({
      id: "t1", title: "ilk", column: "TODO",
      deps: ["x"], reviewNotes: [], attempts: 0, stageHistory: [],
    });
  });

  it("aynı id ikinci kez → hata", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    expect(() => b.addCard({ id: "t1", title: "b" })).toThrow(/zaten var/);
  });

  it("get bilinmeyen id'de undefined döner", () => {
    expect(new Board().get("yok")).toBeUndefined();
  });

  it("list ekleme sırasını korur; byColumn filtreler", () => {
    const b = new Board();
    b.addCard({ id: "a", title: "a" });
    b.addCard({ id: "b", title: "b" });
    expect(b.list().map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("TODO").map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("DONE")).toEqual([]);
  });

  it("get savunmalı kopya döner (dış mutasyon iç durumu bozmaz)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    const c = b.get("t1")!;
    c.reviewNotes.push("dışarıdan");
    c.column = "DONE";
    expect(b.get("t1")!.reviewNotes).toEqual([]);
    expect(b.get("t1")!.column).toBe("TODO");
  });
});
