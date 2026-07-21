import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

describe("TuiController", () => {
  it("onEvent phase → state.phase günceller + listener çağrılır", () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "phase", phase: "waves", detail: "x" });
    expect(c.getState().phase).toBe("waves");
    expect(c.getState().detail).toBe("x");
    expect(notified).toBe(1);
  });

  it("onEvent board → state.cards günceller", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    expect(c.getState().cards).toEqual([{ id: "a", title: "A", column: "TODO" }]);
  });

  it("ask pending set eder + notify; answer promise'i çözer + pending temizler", async () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    const p = c.ask("Devam?");
    expect(c.getState().pending).toEqual({ question: "Devam?" });
    expect(notified).toBe(1);
    c.answer("evet");
    expect(await p).toBe("evet");
    expect(c.getState().pending).toBeUndefined();
    expect(notified).toBe(2);
  });

  it("getState mutasyonda yeni referans döner (React re-render için)", () => {
    const c = new TuiController();
    const s0 = c.getState();
    c.onEvent({ kind: "phase", phase: "p" });
    expect(c.getState()).not.toBe(s0);
  });

  it("subscribe dönüşü unsubscribe eder", () => {
    const c = new TuiController();
    let n = 0;
    const off = c.subscribe(() => { n++; });
    c.onEvent({ kind: "phase", phase: "a" });
    off();
    c.onEvent({ kind: "phase", phase: "b" });
    expect(n).toBe(1);
  });
});
