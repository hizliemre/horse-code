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

  it("onChange her mutasyonda çağrılır", () => {
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

  it("onChange yoksa mutasyon normal çalışır (geriye uyumlu)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "X" });
    b.move("t1", "DONE");
    expect(b.get("t1")!.column).toBe("DONE");
  });
});
