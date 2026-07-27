import { describe, it, expect } from "vitest";
import { withDeadline } from "../../src/agent/deadline.js";

/**
 * The agent loop tests its signal at the TOP of each turn, which bounds turns rather than time: one turn is a
 * model response plus every tool call it asked for, and a shell command runs for minutes. A task was observed
 * still held at 26 minutes on a 20-minute budget — the abort had fired, the loop had not come back round.
 */
describe("withDeadline", () => {
  it("returns the work's result when it finishes first", async () => {
    const ac = new AbortController();
    await expect(withDeadline(Promise.resolve("done"), ac.signal, "too slow")).resolves.toBe("done");
  });

  it("stops waiting the moment the budget aborts, however busy the work is", async () => {
    const ac = new AbortController();
    const never = new Promise<string>(() => { /* a turn that will not come back round */ });
    setTimeout(() => ac.abort(), 10);
    await expect(withDeadline(never, ac.signal, "budget spent")).rejects.toThrow("budget spent");
  });

  it("fails immediately when the budget is already spent", async () => {
    const never = new Promise<string>(() => { /* … */ });
    await expect(withDeadline(never, AbortSignal.abort(), "budget spent")).rejects.toThrow("budget spent");
  });

  /** The work's own error is what the caller needs to see — the deadline was not what went wrong. */
  it("reports the work's failure when the work fails first", async () => {
    const ac = new AbortController();
    await expect(withDeadline(Promise.reject(new Error("model exploded")), ac.signal, "budget spent"))
      .rejects.toThrow("model exploded");
  });

  /**
   * The loser keeps unwinding in the background. Its rejection must not reach the process as an unhandled
   * one — a crash caused by the timeout handling would be worse than the timeout.
   */
  it("does not leave the abandoned work as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => { seen.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late failure")), 5));
      await expect(withDeadline(late, AbortSignal.abort(), "budget spent")).rejects.toThrow("budget spent");
      await new Promise((r) => setTimeout(r, 40));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
