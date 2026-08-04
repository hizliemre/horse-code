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
    expect(m).toMatch(/same file/i);                        // no splitting one file
  });

  it("carries deferred review notes through untouched", () => {
    expect(tasksMessage("p.md", "t.md", "T", ["watch the fallback path"])).toContain("watch the fallback path");
  });
});
