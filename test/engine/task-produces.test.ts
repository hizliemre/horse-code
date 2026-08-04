import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";
import { structuralFindings, isInvestigation } from "../../src/engine/task-audit.js";

const board = (titles: string[]): Board => {
  const b = new Board();
  titles.forEach((t, i) => b.addCard({
    id: `T${i}`, title: t, acceptance: [`${t} is done, checked in src/thing.ts`], files: ["src/thing.ts"],
  }));
  return b;
};

/**
 * A task whose deliverable is knowledge is not a task.
 *
 * Measured on a live run — one request became 27 cards, and its first three were:
 *
 *   "Verify and anchor Nx workspace environment in toucan/package.json"
 *   "Inspect existing dependencies, specifically checking isomorphic-dompurify version 2.25.0"
 *   "Verify linting config files eslint.config.mjs for toucan-utils and products"
 *
 * Each passed every structural check: it named files, it had acceptance criteria, it was not a duplicate.
 * Each then bought an implementer, a code review and an acceptance gate — to find something out. Finding
 * things out is what an implementer does INSIDE the task that needs the answer.
 */
describe("a task has to produce something", () => {
  it("recognises a title whose whole deliverable is looking", () => {
    for (const t of [
      "Verify and anchor Nx workspace environment in toucan/package.json",
      "Inspect existing dependencies, specifically checking isomorphic-dompurify version",
      "Verify linting config files eslint.config.mjs for toucan-utils",
      "Investigate the rendering path",
      "Confirm the API contract matches",
      "Review the existing sanitiser",
      "Analyze current bundle size",
    ]) expect(isInvestigation(t), t).toBe(true);
  });

  it("leaves a task that changes something alone", () => {
    for (const t of [
      "Extend SafeHtmlFallbackRecord interface with failureKind union in safe-html.pipe.ts",
      "Implement SafeHtmlProfile type and profile configurations",
      "Update exports in barrel index.ts to expose pipe types",
      "Write unit tests for SafeHtmlPipe rich and default profiles",
      "Import SafeHtmlPipe into step-summary.ts component metadata",
      "Add a failing test that verifies the fallback path",   // "verifies" mid-sentence is a test, not a survey
    ]) expect(isInvestigation(t), t).toBe(false);
  });

  it("reports it as something to repair, naming what to do instead", () => {
    const found = structuralFindings(board(["Verify linting config files eslint.config.mjs"]));
    const issue = found.map((f) => f.issue).join(" ");
    expect(issue).toMatch(/produces no change|nothing/i);
    expect(issue).toMatch(/fold|inside|part of/i);   // …the remedy, not just the complaint
  });

  it("says nothing about a healthy breakdown", () => {
    expect(structuralFindings(board(["Implement SafeHtmlProfile type in safe-html.pipe.ts"]))).toEqual([]);
  });
});
