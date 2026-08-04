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

/**
 * Moving the row out of TODO was not enough, and the screen said so.
 *
 * The end-of-run check counts everything that is not MERGED, and the row closes to DONE — honestly, because
 * it was never merged. Measured after the first fix, on a run whose 27 tasks had all merged and whose review
 * had APPROVED: the report still read "1 task(s) were not finished. The board is kept — say continue".
 */
describe("the closed row is not counted as unfinished work", () => {
  it("is excluded from the end-of-run tally by identity, not by column", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/job.ts", "utf8");
    const tally = src.slice(src.indexOf("const unfinished ="), src.indexOf("const unfinished =") + 200);
    expect(tally).toContain("REVISION_CARD");
  });

  /** …and writing the outcome twice reads as two reviews rather than one. */
  it("does not repeat an outcome the pass already recorded", () => {
    const b = new Board();
    b.addCard({ id: REVISION_CARD, title: "PR revision" });
    b.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:approved" });
    closeRevision(b, { status: "approved", rounds: 0 });
    const approvals = (b.get(REVISION_CARD)?.stageHistory ?? []).filter((h) => h.action === "pr:approved");
    expect(approvals.length).toBe(1);
  });
});
