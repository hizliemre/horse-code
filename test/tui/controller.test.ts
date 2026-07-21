import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

describe("TuiController", () => {
  it("onEvent phase → updates state.phase + calls the listener", () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "phase", phase: "waves", detail: "x" });
    expect(c.getState().phase).toBe("waves");
    expect(c.getState().detail).toBe("x");
    expect(notified).toBe(1);
  });

  it("onEvent board → updates state.cards", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    expect(c.getState().cards).toEqual([{ id: "a", title: "A", column: "TODO" }]);
  });

  it("ask sets pending + notifies; answer resolves the promise + clears pending", async () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    const p = c.ask("Continue?");
    expect(c.getState().pending).toEqual({ question: "Continue?" });
    expect(notified).toBe(1);
    c.answer("yes");
    expect(await p).toBe("yes");
    expect(c.getState().pending).toBeUndefined();
    expect(notified).toBe(2);
  });

  it("getState returns a new reference on mutation (for React re-render)", () => {
    const c = new TuiController();
    const s0 = c.getState();
    c.onEvent({ kind: "phase", phase: "p" });
    expect(c.getState()).not.toBe(s0);
  });

  it("subscribe's return value unsubscribes", () => {
    const c = new TuiController();
    let n = 0;
    const off = c.subscribe(() => { n++; });
    c.onEvent({ kind: "phase", phase: "a" });
    off();
    c.onEvent({ kind: "phase", phase: "b" });
    expect(n).toBe(1);
  });

  it("awaitTask mode=input + notify; submitTask resolves the promise", async () => {
    const c = new TuiController();
    let n = 0; c.subscribe(() => { n++; });
    const p = c.awaitTask();
    expect(c.getState().mode).toBe("input");
    expect(n).toBe(1);
    c.submitTask("a task");
    expect(await p).toBe("a task");
  });

  it("beginRun mode=running + resets board/phase", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    c.onEvent({ kind: "phase", phase: "waves" });
    c.beginRun();
    expect(c.getState().mode).toBe("running");
    expect(c.getState().cards).toEqual([]);
    expect(c.getState().phase).toBe("");
  });

  it("submitTask appends the user message to the transcript", async () => {
    const c = new TuiController();
    const p = c.awaitTask();
    c.submitTask("task-1");
    await p;
    expect(c.getState().transcript).toEqual([{ role: "user", text: "task-1" }]);
  });

  it("endRun appends the assistant message + mode=input", () => {
    const c = new TuiController();
    c.endRun("report text");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "report text" }]);
  });

  it("beginRun preserves the transcript (resets the board)", () => {
    const c = new TuiController();
    c.endRun("previous");
    c.beginRun();
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "previous" }]);
    expect(c.getState().cards).toEqual([]);
  });

  it("one-shot: mode stays undefined if never set (backward compatibility)", () => {
    expect(new TuiController().getState().mode).toBeUndefined();
  });
});
