import { describe, it, expect } from "vitest";
import { describeTally, tallyBoard, DELIVERED_SHARE } from "../../src/engine/tally.js";

/**
 * The tally the user most needed was the one that never printed.
 *
 * A run of 124 tasks merged 4 and then threw on an unroutable model. It said where the work was kept and
 * nothing about what the work amounted to, because the counting lived on the success path alone. The user
 * read "the work is on hc/…, merge it when you are ready" and asked, reasonably, whether the tasks were
 * done. They were not: 3 had failed and 117 had never been attempted, all behind one task whose description
 * contradicted the spec.
 */
describe("counting a run's outcome", () => {
  it("reports the run that caused this, in the words its user needed", () => {
    const text = describeTally({ merged: 4, failed: 3, blocked: 117, unfinished: 0 });
    expect(text).toContain("4 of 124 tasks merged");
    expect(text).toContain("3 failed");
    expect(text).toContain("117 blocked behind them");
    expect(text).toContain("the feature is not built");
  });

  it("says nothing alarming when everything landed", () => {
    expect(describeTally({ merged: 12, failed: 0, blocked: 0, unfinished: 0 })).toBe("12 of 12 tasks merged");
  });

  it("names an interrupted run's open tasks as open, not as blocked", () => {
    const text = describeTally({ merged: 8, failed: 0, blocked: 0, unfinished: 2 });
    expect(text).toContain("2 still open");
    expect(text).not.toContain("blocked");
  });

  /** "Most of the plan did not land" has to be true when it is said. */
  it("warns below the share and not at it", () => {
    expect(DELIVERED_SHARE).toBe(0.5);
    expect(describeTally({ merged: 4, failed: 6, blocked: 0, unfinished: 0 })).toContain("⚠️");
    expect(describeTally({ merged: 5, failed: 5, blocked: 0, unfinished: 0 })).not.toContain("⚠️");
  });

  it("survives a run that planned nothing", () => {
    expect(describeTally({ merged: 0, failed: 0, blocked: 0, unfinished: 0 })).toBe("no tasks were planned");
  });
});

/**
 * An abandoned card that was attempted and one that never ran are the same column and different failures.
 * `attempts` is the only thing that separates them, and the difference is what tells the reader where to look.
 */
describe("reading the outcome off a saved board", () => {
  it("separates what failed from what never got a turn", () => {
    const t = tallyBoard([
      { id: "T1", column: "MERGED" },
      { id: "T2", column: "ABANDONED", attempts: 6 },
      { id: "T3", column: "ABANDONED", attempts: 0 },
      { id: "T4", column: "ABANDONED" },          // no attempts field at all → never ran
      { id: "T5", column: "TODO" },
    ]);
    expect(t).toEqual({ merged: 1, failed: 1, blocked: 2, unfinished: 1 });
  });

  /** The revision row is bookkeeping. It was published as a task once, and counted as one long after. */
  it("leaves the revision row out of the count", () => {
    const t = tallyBoard([{ id: "T1", column: "MERGED" }, { id: "__revision__", column: "DONE" }]);
    expect(t).toEqual({ merged: 1, failed: 0, blocked: 0, unfinished: 0 });
  });
});
