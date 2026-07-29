import { describe, it, expect } from "vitest";
import { withDeadline, callSignal, SHORT_CALL_MS, LONG_CALL_MS } from "../../src/agent/deadline.js";

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

/**
 * The implementer and the review lenses were each given a deadline after they were seen to hang. The one-shot
 * calls were not, because they are quick — and a call that hangs is not quick.
 *
 * Caught live: the call that writes a task's commit message sat open for eight minutes, so the task stayed at
 * DONE without ever merging, and TEN tasks queued behind it never started. One request stalled the whole run.
 */
describe("callSignal", () => {
  it("aborts on its own deadline, without waiting for the job", async () => {
    const job = new AbortController();
    const s = callSignal(job.signal, 20);
    expect(s.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.aborted).toBe(true);
    expect(job.signal.aborted).toBe(false); // the job is untouched
  });

  /** Composed, not replaced: cancelling the job must still cancel the call. */
  it("aborts when the job does, long before its own deadline", () => {
    const job = new AbortController();
    const s = callSignal(job.signal, 60_000);
    job.abort();
    expect(s.aborted).toBe(true);
  });

  it("is generous by default — a call is not late just because it is slow", () => {
    expect(SHORT_CALL_MS).toBeGreaterThanOrEqual(60_000);
    expect(LONG_CALL_MS).toBeGreaterThan(SHORT_CALL_MS);
  });
});
