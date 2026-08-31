/**
 * Below this share of tasks merged, a run did not build the feature — whatever else it did.
 *
 * Not a precise line, and it does not need to be: it decides which SENTENCE the user reads, and the numbers
 * are printed either way. What it prevents is a run that landed a thirtieth of its plan reading like one
 * that landed all of it.
 */
export const DELIVERED_SHARE = 0.5;

export interface Tally {
  merged: number;
  /** Attempted and rejected — a real failure, with a reason on the card. */
  failed: number;
  /** Never attempted: parked behind work that never arrived. A different fact, and a different thing to fix. */
  blocked: number;
  /** Still open when the run ended — only possible when it ended early. */
  unfinished: number;
}

/**
 * What LANDED, first. It is the number the user's next decision depends on.
 *
 * Measured live, twice. A run of 34 tasks merged 3 and reported "Partial: 4 failed, 27 skipped"; the user
 * read it as finished and asked to move on to smoke testing. A later run of 124 merged 4 — and ended on an
 * error, so the tally never printed at all, which is why this lives in one place that BOTH endings call.
 *
 * "blocked" rather than "skipped": those tasks were never attempted, they were parked behind work that
 * never arrived. "Skipped" reads like a decision somebody took, and it sends the reader looking for the
 * wrong problem — the fix is never in the blocked tasks, it is in the one blocking them.
 */
export function describeTally(t: Tally): string {
  const total = t.merged + t.failed + t.blocked + t.unfinished;
  if (!total) return "no tasks were planned";
  const parts = [
    t.failed ? `${t.failed} failed` : "",
    t.blocked ? `${t.blocked} blocked behind them` : "",
    t.unfinished ? `${t.unfinished} still open` : "",
  ].filter(Boolean).join(", ");
  const head = `${t.merged} of ${total} tasks merged`;
  if (t.merged === total) return head;
  return t.merged / total < DELIVERED_SHARE
    ? `⚠️ ${head} — ${parts}. Most of the plan did not land; the feature is not built.`
    : `${head} — ${parts}.`;
}

/** A board card, read only for its outcome. Shaped loosely: this also reads a board.json off disk. */
interface CardLike { id?: string; column?: string; attempts?: number }

/**
 * The tally as the BOARD saw it — the only account that survives a run ending badly.
 *
 * An abandoned card that was attempted and one that never ran are the same column and different failures,
 * and `attempts` is what separates them.
 */
export function tallyBoard(cards: readonly CardLike[], revisionCardId = "__revision__"): Tally {
  const t: Tally = { merged: 0, failed: 0, blocked: 0, unfinished: 0 };
  for (const c of cards) {
    if (c.id === revisionCardId) continue; // bookkeeping, not work — it was published as a task once
    if (c.column === "MERGED") t.merged++;
    else if (c.column === "ABANDONED") (c.attempts ?? 0) > 0 ? t.failed++ : t.blocked++;
    else t.unfinished++;
  }
  return t;
}
