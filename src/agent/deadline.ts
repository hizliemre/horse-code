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
 * Raised to five when these calls moved onto the CLIs. The reasoning above still holds — a sentence written
 * from a diff really has gone wrong by then — but the floor moved: a delegated call pays process start-up
 * and an agent loop before it writes anything. Measured over 19 such calls, p50 8s and p90 15s, so the
 * ceiling is far above ordinary work and only ever catches a hang; one call still hit it, which is the whole
 * argument for leaving that much room.
 */
export const SHORT_CALL_MS = 5 * 60 * 1000;
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

/**
 * A caller's cancellation, as distinct from a deadline of ours running out.
 *
 * Both abort the same signal, and treating them alike is wrong in two ways at once: our own deadline gets
 * reported as "cancelled" — a word that says a person did it — and marked NON-retryable, so the chain never
 * tries the next model even though another one might answer in time.
 *
 * Every deadline in the pipeline arrives this way: `callSignal` composes each one onto the caller's signal,
 * so read carelessly every single one of them looks like the user pressing Ctrl+C.
 *
 * `AbortSignal.any` keeps the reason of whichever source fired, which is what makes them separable at all:
 * a timeout leaves a `TimeoutError`, a caller's `abort()` leaves an `AbortError`.
 */
export function isCallerAbort(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name !== "TimeoutError";
}

/** Our own deadline, not the caller's decision — worth saying differently, and worth retrying elsewhere. */
export function isDeadline(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
}
