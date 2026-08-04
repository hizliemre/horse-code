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

/**
 * Two more shapes from the same 27-card board, both measured.
 *
 *   5 cards wrote only `safe-html.pipe.ts`      4 wrote only `safe-html.pipe.spec.ts`
 *   3 wrote only `step-summary.html`            5 only ran a command (lint ×2, format, build, validate)
 *
 * Cards on one file cannot run in parallel — the wave engine already knows two tasks writing the same file
 * are not independent — so splitting one file five ways buys five implementers, five code reviews and five
 * acceptance gates, in a queue, for one coherent change.
 *
 * And a card that only runs a command leaves nothing behind either. Linting, formatting and building are how
 * a task is known to be finished; they are the definition of done for the cards that changed the code, not
 * work of their own.
 */
describe("a breakdown that costs more than the work", () => {
  const cardsOn = (file: string, n: number): Board => {
    const b = new Board();
    for (let i = 0; i < n; i++) {
      b.addCard({ id: `T${i}`, title: `Implement part ${i} in ${file}`, acceptance: [`part ${i} exists in ${file}`], files: [file] });
    }
    return b;
  };

  it("objects when one file is split across too many tasks", async () => {
    const { structuralFindings } = await import("../../src/engine/task-audit.js");
    const issue = structuralFindings(cardsOn("src/safe-html.pipe.ts", 5)).map((f) => f.issue).join(" ");
    expect(issue).toMatch(/same file/i);
    expect(issue).toMatch(/safe-html\.pipe\.ts/);
    expect(issue).toMatch(/parallel|sequen|queue/i);   // the reason, not just the count
  });

  it("leaves a file split two ways alone — that is a judgement, not a pattern", async () => {
    const { structuralFindings } = await import("../../src/engine/task-audit.js");
    expect(structuralFindings(cardsOn("src/a.ts", 2))).toEqual([]);
  });

  it("recognises a card whose whole content is running a command", async () => {
    const { isChore } = await import("../../src/engine/task-audit.js");
    for (const t of [
      "Lint @toucan/utils project using npx nx lint toucan-utils",
      "Format both projects using npx nx format:write",
      "Build Beempa production target using npx nx build beempa",
      "Run quickstart.md validation and document scenario",
      "Typecheck the workspace",
    ]) expect(isChore(t), t).toBe(true);
    for (const t of [
      "Write unit tests for SafeHtmlPipe rich and default profiles",
      "Build the SafeHtmlProfile type and its configuration table",   // "Build" as authoring, with an object
      "Implement SafeHtmlTextProjector service",
    ]) expect(isChore(t), t).toBe(false);
  });
});
