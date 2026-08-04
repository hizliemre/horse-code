import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

/**
 * Cancelling while a question is up did everything except the one thing that mattered.
 *
 * `ask()` hands out a promise that only `answer()` resolves. Ctrl+C aborted the job's signal and left that
 * promise pending for ever: the agent stayed parked on a question nobody could withdraw, and the answer box
 * stayed open. Reported as "Ctrl+C does not cancel a question", and it was exactly true — the keystroke was
 * handled, the signal was aborted, and nothing moved.
 */
describe("cancelling a question the run is waiting on", () => {
  it("releases the agent blocked on it", async () => {
    const c = new TuiController();
    const asked = c.ask("How should I proceed?");
    let settled = false;
    void asked.then(() => { settled = true; });
    expect(settled).toBe(false);
    c.cancelPending();
    await asked;
    expect(settled).toBe(true);
  });

  /** Empty rather than a rejection: every caller already handles the answer someone gives by pressing Enter. */
  it("answers empty rather than throwing into whichever phase was asking", async () => {
    const c = new TuiController();
    const asked = c.ask("Which one?");
    c.cancelPending();
    await expect(asked).resolves.toBe("");
  });

  it("takes the question off the screen", () => {
    const c = new TuiController();
    void c.ask("Which one?");
    expect(c.getState().pending).toBeDefined();
    c.cancelPending();
    expect(c.getState().pending).toBeUndefined();
  });

  it("does nothing at all when no question is up", () => {
    const c = new TuiController();
    expect(() => c.cancelPending()).not.toThrow();
    expect(c.getState().pending).toBeUndefined();
  });

  /** …and a real answer still works, unchanged. */
  it("leaves answering alone", async () => {
    const c = new TuiController();
    const asked = c.ask("Which one?");
    c.answer("the second");
    await expect(asked).resolves.toBe("the second");
  });
});

/** The keystroke path: the question is withdrawn BEFORE the signal, or the run cannot end. */
describe("what Ctrl+C does on the second press", () => {
  it("withdraws the question and then cancels the job", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/tui/components.tsx", "utf8");
    const at = src.indexOf("if (cancelArmed) {");
    const block = src.slice(at, at + 500);
    expect(block).toContain("controller.cancelPending()");
    expect(block.indexOf("cancelPending()")).toBeLessThan(block.indexOf("cancelJob?.()"));
  });
});
