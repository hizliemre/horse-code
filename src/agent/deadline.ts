/**
 * Makes an abort signal a real deadline for a piece of work.
 *
 * The agent loop checks its signal at the TOP of each turn. That bounds the number of turns, not the time: a
 * single turn is a model response plus every tool call it asked for, and a shell command may run for minutes.
 * A 20-minute implementer budget was observed still holding a task at 26 minutes — the abort had fired, the
 * loop simply had not come back round to look.
 *
 * The work keeps unwinding on the same signal in the background; this only stops the CALLER waiting for it.
 */
export function withDeadline<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  // Whoever loses the race must not surface as an unhandled rejection; the winner's error is the one reported.
  work.catch(() => { /* reported through the race, or irrelevant because the deadline won */ });
  return Promise.race([work, expired(signal, message)]);
}

function expired(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new Error(message)); return; }
    signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

/**
 * How long a SHORT structured call may take before it is abandoned.
 *
 * The implementer and the review lenses were each given a deadline after they were seen to hang. The one-shot
 * calls were not, because they are quick — and a call that hangs is not quick. Caught live: the call that
 * writes a task's commit message sat open for eight minutes on `antigravity/gemini-2.5-pro`, so the task
 * stayed at DONE without ever merging, and TEN tasks queued behind it never started. One request stalled the
 * whole run, and only the in-flight counter could say so.
 *
 * These are generous: a sentence written from a diff that takes three minutes has already gone wrong.
 */
export const SHORT_CALL_MS = 3 * 60 * 1000;
/** A judgement over a whole change — bigger input, same principle. */
export const LONG_CALL_MS = 15 * 60 * 1000;

/**
 * The job's own signal, plus a deadline of its own.
 *
 * Composed rather than replacing: a cancelled job must still cancel the call, and a hung call must still end
 * without waiting for the job.
 */
export function callSignal(signal: AbortSignal, ms = SHORT_CALL_MS): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
