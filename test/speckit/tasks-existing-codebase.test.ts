import { describe, it, expect } from "vitest";
import { tasksMessage } from "../../src/speckit/phases.js";

/**
 * The 27-card board, explained.
 *
 * spec-kit's `tasks-template.md` is written for a project being CREATED. Its phases are Setup ("Configure
 * linting and formatting tools"), Foundational ("Create base models/entities that all stories depend on"),
 * one phase per user story, and Polish ("Documentation updates", "Code cleanup", "Run quickstart.md
 * validation"). Its examples split by entity: "Create Entity1 model", "Create Entity2 model".
 *
 * Given that template and a one-line rendering fix in an existing repository, the planner produced exactly
 * that shape — three setup cards that verify the workspace and the lint config, five foundational cards
 * splitting one file by symbol, and a polish tail of lint, format, build and "Run quickstart.md validation",
 * which is in the template word for word.
 *
 * The planner was not being silly. It was being faithful to a template about a different situation.
 */
describe("the task list is for a codebase that already exists", () => {
  const msg = (): string => tasksMessage("plan.md", "tasks.md", "TEMPLATE-BODY", []);

  it("says which parts of the template do not apply here", () => {
    const m = msg();
    expect(m).toMatch(/already exists|existing (code)?base/i);
    expect(m).toMatch(/setup|foundational/i);   // the phases that assume a project being created
    expect(m).toMatch(/polish/i);
  });

  it("still hands over the template — the format is the part that is wanted", () => {
    expect(msg()).toContain("TEMPLATE-BODY");
  });

  it("keeps the rules that came from the same board", () => {
    const m = msg();
    expect(m).toMatch(/leave the repository DIFFERENT/i);   // no investigation tasks
    expect(m).toMatch(/lint|format|building/i);             // no command-only tasks
    expect(m).toMatch(/Never split one file across two tasks/i);
  });

  /**
   * "One file is usually one task" stopped five cards landing on one file, then quietly became the SIZING
   * rule — so a plan touching 125 files produced 125 cards, each carrying a full review team, a council and
   * an acceptance gate. Measured on that board: 10.5 review calls per card on one run and 43.4 on the next,
   * the latter 86% of everything the run spent.
   */
  it("sizes a task by behaviour rather than by file", () => {
    const m = msg();
    expect(m).toMatch(/coherent piece of BEHAVIOUR/);
    expect(m).toMatch(/not to a file/);
    expect(m).toMatch(/ONE entity with its configuration, its migration and its tests is one task/i);
    expect(m).toContain("splitting finer does not");
  });

  /**
   * The template's phases pull one file apart on their own: Setup creates the file empty and Core fills it,
   * which turned one configuration class into T004 and T016 — both implemented, reviewed and merged, five
   * more entities the same way. A sentence about files could not outrank a phase heading, so the rule has to
   * name the phases.
   */
  /**
   * Both directions cost. Without an upper bound "one entity and its configuration" was read as "the data
   * model": a 19-file card came back from review five times for 96 review calls, against 35 for a 2-file
   * card that merged first time. Review cost tracks attempts times team size, and attempts climb with how
   * much a reviewer must hold at once.
   */
  it("bounds a task from above as well as below", () => {
    const m = msg();
    expect(m).toMatch(/ONE entity, not the data model/);
    expect(m).toContain("splitting finer does not");
  });

  /**
   * The first ceiling named a file count — "roughly two to six files" — drawn between a 3-file card that
   * merged on its second attempt and a 19-file card that took six. The next reading broke it: a FOUR-file
   * card, inside that window, took four attempts and 80 review calls, as many as cards three times its size.
   * A number that reads as measured and is not is worse than no number.
   */
  it("names breadth rather than a file count it cannot support", () => {
    const m = msg();
    expect(m).toContain("Do not count files");
    expect(m).toMatch(/how many separate decisions a reviewer must hold at once/);
    expect(m).not.toMatch(/two to six files/i);
  });

  it("forbids splitting one file across the template's phases", () => {
    expect(msg()).toMatch(/includes across PHASES/);
    expect(msg()).toMatch(/creating a file empty in Setup and filling it in later is one task/i);
  });

  it("carries deferred review notes through untouched", () => {
    expect(tasksMessage("p.md", "t.md", "T", ["watch the fallback path"])).toContain("watch the fallback path");
  });
});
