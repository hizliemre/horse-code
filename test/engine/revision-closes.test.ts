import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";
import { REVISION_CARD, closeRevision } from "../../src/engine/revision.js";

/**
 * A bookkeeping row that is never closed makes every finished run look unfinished.
 *
 * Measured at the end of a 577-minute run: all 27 tasks merged, the pull request opened — and the report
 * said "1 task(s) were not finished. The board is kept — say continue to pick them up", because
 * `__revision__` was still sitting in TODO. Nothing ever moves it: the revision pass writes its rounds into
 * the card's HISTORY and leaves the column alone.
 *
 * Telling someone to "say continue" about work that is done is worse than saying nothing: continuing is
 * exactly what would re-open it.
 */
describe("the revision row is closed when the pass ends", () => {
  const withCard = (): Board => {
    const b = new Board();
    b.addCard({ id: REVISION_CARD, title: "PR revision" });
    return b;
  };

  it("moves it out of TODO on every outcome the pass can reach", () => {
    for (const status of ["approved", "accepted", "human"] as const) {
      const b = withCard();
      closeRevision(b, { status, rounds: 1, ...(status === "human" ? { answer: "ship it" } : {}) } as never);
      expect(b.get(REVISION_CARD)?.column, status).not.toBe("TODO");
    }
  });

  /** …and when it could not run at all, which is the case the report was misreading. */
  it("closes it when the pass failed, rather than leaving it as unfinished work", () => {
    const b = withCard();
    closeRevision(b, undefined, "the comments could not be posted");
    expect(b.get(REVISION_CARD)?.column).not.toBe("TODO");
    // `move` appends its own entry, so the reason is looked for in the history rather than at the end of it.
    const history = b.get(REVISION_CARD)?.stageHistory ?? [];
    expect(history.some((h) => (h.note ?? "").includes("could not be posted"))).toBe(true);
    expect(history.some((h) => h.action === "pr:failed")).toBe(true);
  });

  it("does nothing when there is no revision row — a run that never opened a PR has none", () => {
    const b = new Board();
    expect(() => closeRevision(b, { status: "approved", rounds: 0 })).not.toThrow();
  });
});
