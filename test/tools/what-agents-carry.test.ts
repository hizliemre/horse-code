import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../src/tools/index.js";
import { GRAPH_TOOLS } from "../../src/tools/graph.js";

/**
 * An agent reaches for what it has, and shell was all most of them had.
 *
 * Measured over one 577-minute run: 298 of 1,216 shell commands were git, and 320 of the 356 git verbs
 * inside them were read-only — `status` 84 times, `diff` 81, `log` 64, `show` 57. Of the 62 agents that used
 * shell, **58 never called the `git` tool once**. That is not a preference: `createDefaultRegistry` did not
 * carry it, so an implementer or a reviser had nothing else to reach for.
 *
 * The git tool refuses everything that changes anything, so withholding it bought nothing and cost a run's
 * worth of shell commands — each of which is coarser, unbounded, and (since the recall memo) more expensive.
 */
describe("what every agent carries", () => {
  const names = (): string[] => createDefaultRegistry().list().map((t) => t.name);

  it("includes read-only git, so nobody has to shell out for `git status`", () => {
    expect(names()).toContain("git");
  });

  it("still carries the tools it always did", () => {
    for (const t of ["read_file", "write_file", "edit_file", "grep", "glob", "shell"]) {
      expect(names(), t).toContain(t);
    }
  });

  /** Write-capable git must stay out of the safe set, whatever else changes. */
  it("carries no git that can change anything", () => {
    const git = createDefaultRegistry().get("git");
    expect(git?.permissionLevel).toBe("safe");
    expect(git?.description).toMatch(/READ-ONLY/);
  });
});

/**
 * The reviser writes the LAST code to enter the pull request, and it was the worst-equipped agent in the run.
 *
 * `principalReview` reads through `readOnlyRegistry`, which carries git, the code graph and the project's
 * read-only MCP tools. `seniorRevise` had the default registry and a skill tool — so it could not ask what
 * calls the function it was about to change, and every git question it had went through shell.
 */
describe("the reviser sees the project it is changing", () => {
  it("is given the graph tools, like the implementer is", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/revision.ts", "utf8");
    const senior = src.slice(src.indexOf("async function seniorRevise"));
    expect(senior.slice(0, 1500)).toContain("contextTools(deps)");
  });

  it("and the graph tools are a real set, not an empty one", () => {
    expect(GRAPH_TOOLS.length).toBeGreaterThan(0);
    expect(GRAPH_TOOLS.every((t) => t.permissionLevel === "safe")).toBe(true);
  });
});
