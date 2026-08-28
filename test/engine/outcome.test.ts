import { describe, it, expect } from "vitest";
import { describeOutcome, DELIVERED_SHARE } from "../../src/cli.js";
import type { WaveEngineResult } from "../../src/engine/wave-engine.js";

const delivery = { branch: "hc/job/base", worktree: "/repo/.horsecode/worktrees/job" };
const session = {} as WaveEngineResult["session"];

/** `waves` is the plan, so its flattened length is how many tasks the run set out to do. */
const partial = (total: number, failed: number, skipped: number): WaveEngineResult => ({
  status: "partial",
  session,
  failed: Array.from({ length: failed }, (_, i) => `F${i}`),
  skipped: Array.from({ length: skipped }, (_, i) => `S${i}`),
  delivery,
  waves: [Array.from({ length: total }, (_, i) => `T${i}`)],
});

/**
 * The run that caused this, with its real numbers.
 *
 * 34 tasks: 3 merged, 4 failed after six attempts each, 27 never attempted — every one parked waiting on a
 * dependency that never arrived. The report said "Status: partial — Partial: 4 failed, 27 skipped", the user
 * read the run as finished, and asked to move on to local smoke testing. Nothing in that line was false. It
 * never said three of thirty-four, and "4 failed" is a small number at the end of a long report.
 */
describe("what a finished run says it achieved", () => {
  it("leads with what merged, not with what failed", () => {
    const text = describeOutcome(partial(34, 4, 27));
    expect(text).toContain("3 of 34 tasks merged");
    expect(text.indexOf("3 of 34")).toBeLessThan(text.indexOf("failed"));
  });

  it("says plainly that the feature is not built when most of the plan did not land", () => {
    const text = describeOutcome(partial(34, 4, 27));
    expect(text).toContain("the feature is not built");
    expect(text).toContain("⚠️");
  });

  /**
   * "Skipped" reads like a decision somebody took. Those tasks were never attempted at all — they were
   * parked behind work that never arrived, which is a different fact and a different thing to fix.
   */
  it("calls the untried tasks blocked, not skipped", () => {
    const text = describeOutcome(partial(34, 4, 27));
    expect(text).toContain("27 blocked behind them");
    expect(text).not.toContain("skipped");
  });

  it("does not cry wolf when most of the work did land", () => {
    const text = describeOutcome(partial(20, 1, 1));
    expect(text).toBe("18 of 20 tasks merged — 1 failed, 1 blocked behind them.");
    expect(text).not.toContain("⚠️");
  });

  /**
   * The threshold decides which SENTENCE is read; the numbers are printed either way.
   *
   * Exactly half deliberately does not warn. "Most of the plan did not land" has to be true when it is said,
   * and at 5 of 10 it is not — the boundary is asserted here rather than left to whoever reads `<` next.
   */
  it("warns below DELIVERED_SHARE and not at it", () => {
    expect(DELIVERED_SHARE).toBe(0.5);
    expect(describeOutcome(partial(10, 6, 0))).toContain("⚠️");      // 4 of 10 merged
    expect(describeOutcome(partial(10, 5, 0))).not.toContain("⚠️");  // 5 of 10 — half is not "most"
    expect(describeOutcome(partial(10, 4, 0))).not.toContain("⚠️");  // 6 of 10 merged
  });

  it("names only the categories that happened", () => {
    expect(describeOutcome(partial(10, 2, 0))).toBe("8 of 10 tasks merged — 2 failed.");
    expect(describeOutcome(partial(10, 0, 2))).toBe("8 of 10 tasks merged — 2 blocked behind them.");
  });

  it("still leads with the pull request when there is one", () => {
    const done: WaveEngineResult =
      { status: "completed", session, pr: { url: "https://x/1" }, delivery, waves: [["T0"]] };
    expect(describeOutcome(done)).toBe("PR: https://x/1");
  });

  it("says merged, not completed, when every task landed without a remote", () => {
    const done: WaveEngineResult = { status: "completed", session, delivery, waves: [["T0"]] };
    expect(describeOutcome(done)).toBe("all tasks merged");
  });

  /** A plan that never produced waves must not divide by zero on the way to reporting failure. */
  it("survives a run with no plan to count against", () => {
    expect(describeOutcome({ ...partial(0, 2, 0), waves: [] })).toContain("0 of 2");
  });
});
