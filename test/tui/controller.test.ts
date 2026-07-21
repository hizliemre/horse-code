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

  it("onEvent refined → replaces the last user message live", () => {
    const c = new TuiController();
    c.awaitTask();
    c.submitTask("raw prompt");
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "refined", refinedPrompt: "Refined prompt" });
    expect(c.getState().transcript).toEqual([{ role: "user", text: "Refined prompt" }]);
    expect(notified).toBe(1);
  });

  it("onEvent refined → no-op when the last message isn't a user message", () => {
    const c = new TuiController();
    c.endRun("assistant only");
    c.onEvent({ kind: "refined", refinedPrompt: "Refined prompt" });
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "assistant only" }]);
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

  it("submitTask while no consumer is waiting → queues instead of appending", () => {
    const c = new TuiController();
    c.submitTask("queued while busy");
    expect(c.getState().queued).toBe(1);
    expect(c.getState().transcript).toEqual([]);
  });

  it("awaitTask drains a queued prompt immediately (append + resolve)", async () => {
    const c = new TuiController();
    c.submitTask("q1"); // queued (nobody awaiting)
    const p = c.awaitTask();
    expect(await p).toBe("q1");
    expect(c.getState().transcript).toEqual([{ role: "user", text: "q1" }]);
    expect(c.getState().queued).toBe(0);
  });

  it("onUsage accumulates turn tokens + tracks the latest active model", () => {
    const c = new TuiController();
    c.beginRun();
    c.onUsage({ model: "m-a", promptTokens: 10, completionTokens: 5 });
    c.onUsage({ model: "m-b", promptTokens: 3, completionTokens: 2 });
    const meta = c.getState().meta!;
    expect(meta.model).toBe("m-b");
    expect(meta.promptTokens).toBe(13);
    expect(meta.completionTokens).toBe(7);
    expect(meta.running).toBe(true);
  });

  it("beginRun resets meta + starts the clock; endRun freezes duration", () => {
    let t = 1000;
    const c = new TuiController(() => t);
    c.beginRun();
    c.onUsage({ model: "m", promptTokens: 4, completionTokens: 1 });
    t = 3500;
    c.awaitTask(); // simulate the REPL waiting for the next prompt
    c.submitTask("x");
    c.endRun("report");
    const meta = c.getState().meta!;
    expect(meta.running).toBe(false);
    expect(meta.durationMs).toBe(2500);
    expect(meta.promptTokens).toBe(4);
  });

  it("picker: openPicker → setPickerModels → applyModel flow", () => {
    const c = new TuiController();
    c.openPicker();
    expect(c.getState().mode).toBe("picker");
    expect(c.getState().picker).toEqual({ models: [], loading: true });

    c.setPickerModels(["a/one", "b/two"]);
    expect(c.getState().picker).toEqual({ models: ["a/one", "b/two"], loading: false });

    c.applyModel("a/one");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
    expect(c.getState().currentModel).toBe("a/one");
  });

  it("picker: setPickerError + cancelPicker", () => {
    const c = new TuiController();
    c.openPicker();
    c.setPickerError("network down");
    expect(c.getState().picker).toEqual({ models: [], loading: false, error: "network down" });
    c.cancelPicker();
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
  });

  it("currentModel starts empty", () => {
    expect(new TuiController().getState().currentModel).toBe("");
  });
});
