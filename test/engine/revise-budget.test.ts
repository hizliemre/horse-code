import { describe, it, expect } from "vitest";
import { reviseTurnBudget, REVISE_TURNS_MIN, REVISE_TURNS_MAX } from "../../src/engine/revision.js";

/**
 * The revision ran on the agent loop's default of 50 — a number that knows nothing about the work. Measured
 * on a real PR of seventeen commits: `maximum turn count exceeded (50)`, the pass abandoned, and the card
 * left carrying `pr:changes` while the merged work shipped unreviewed.
 *
 * This was the third fixed ceiling to fail the same way: five minutes for a graph build, twelve turns for a
 * conflict resolution, fifty here. A budget that ignores the size of the job is a guess, and the guess is
 * wrong exactly when the job is big.
 */
describe("the revision budget follows the work", () => {
  it("scales with the number of comments to address", () => {
    expect(reviseTurnBudget(10)).toBeGreaterThan(reviseTurnBudget(2));
    expect(reviseTurnBudget(23)).toBeGreaterThan(50); // the run that died had far more than 50 turns of work
  });

  it("has a floor, because one comment can be the hard one", () => {
    expect(reviseTurnBudget(0)).toBe(REVISE_TURNS_MIN);
    expect(reviseTurnBudget(1)).toBe(REVISE_TURNS_MIN);
  });

  it("has a ceiling, because a budget with no end is not a budget", () => {
    expect(reviseTurnBudget(10_000)).toBe(REVISE_TURNS_MAX);
  });
});
