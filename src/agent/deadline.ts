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
