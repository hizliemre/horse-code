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

/**
 * "No branch, no worktree, nothing to merge" became false the moment these lanes started using a branch.
 *
 * Reported live: that sentence printed under a path reading
 * `.horsecode/worktrees/agent-response-language/base/.specify/memory/constitution.md`. Telling someone to
 * commit their working tree when the work is on a branch sends them looking in the wrong place.
 */
describe("where a written document says it landed", () => {
  it("names the branch and the worktree when it is on one", async () => {
    const { whereItLanded } = await import("../../src/cli.js");
    const said = whereItLanded("/p/.horsecode/worktrees/agent-response-language/base/.specify/memory/constitution.md");
    expect(said).toContain("/p/.horsecode/worktrees/agent-response-language/base");
    expect(said).toMatch(/branch/i);
    expect(said).toMatch(/merge it in/i);
    expect(said).not.toMatch(/no branch/i);
  });

  it("keeps the old words when it really is the working tree", async () => {
    const { whereItLanded } = await import("../../src/cli.js");
    const said = whereItLanded("/p/.specify/memory/constitution.md");
    expect(said).toMatch(/directly in your working tree/i);
    expect(said).toMatch(/no branch/i);
  });
});

/**
 * Cancelling answered the question — and the agent, handed an empty answer, asked another one.
 *
 * Reported live: a choice question was cancelled, a free-text question took its place immediately, and
 * Ctrl+C on THAT one produced a third. The abort fired every time; the run never reached a point where it
 * looks at the signal, because it was busy asking.
 */
describe("a run that has been cancelled", () => {
  it("answers the next question instantly instead of showing it", async () => {
    const c = new TuiController();
    c.cancelPending();
    const asked = c.ask("Is the environment ready?");
    expect(c.getState().pending).toBeUndefined();   // …nothing on screen to answer
    await expect(asked).resolves.toBe("");
  });

  it("keeps doing so, however many the phase asks", async () => {
    const c = new TuiController();
    c.cancelPending();
    for (const q of ["one?", "two?", "three?"]) await expect(c.ask(q)).resolves.toBe("");
    expect(c.getState().pending).toBeUndefined();
  });

  /** …and the next run may ask again: a cancel ends a run, not the session. */
  it("asks normally once a new run begins", async () => {
    const c = new TuiController();
    c.cancelPending();
    c.beginRun();
    void c.ask("Which one?");
    expect(c.getState().pending?.question).toBe("Which one?");
  });
});
