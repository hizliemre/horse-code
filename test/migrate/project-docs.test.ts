import { describe, it, expect } from "vitest";
import { sortProjectDocs, totalBytes, classifyCalls } from "../../src/migrate/project-docs.js";

const f = (path: string, kb = 1) => ({ path, bytes: kb * 1024 });

/**
 * A project's conventions are rarely only in the file a tool is known to read. Measured on a real one:
 * `CLAUDE.md` held 109 KB, and beside it sat 453 more markdown files — among them the architecture notes and
 * standards every agent would otherwise rebuild from scratch.
 */
describe("the project's own markdown", () => {
  it("takes documents nothing else claims", () => {
    const { candidates } = sortProjectDocs([f("docs/architecture.md"), f("docs/standards/naming.md")]);
    expect(candidates.map((c) => c.path)).toEqual(["docs/architecture.md", "docs/standards/naming.md"]);
  });

  it("does not import a file the named list already covers, by path or by name", () => {
    const { candidates } = sortProjectDocs([f("CLAUDE.md"), f("docs/guide.md")], ["CLAUDE.md"]);
    expect(candidates.map((c) => c.path)).toEqual(["docs/guide.md"]);
  });

  it("ignores anything that is not markdown", () => {
    expect(sortProjectDocs([f("src/index.ts"), f("logo.png")]).candidates).toEqual([]);
  });

  it("puts the largest first, so a costly import is visible before it is approved", () => {
    const { candidates } = sortProjectDocs([f("small.md", 1), f("big.md", 90), f("mid.md", 10)]);
    expect(candidates.map((c) => c.path)).toEqual(["big.md", "mid.md", "small.md"]);
  });
});

/**
 * The traces are the sharp exclusion, and their number is not the reason.
 *
 * A trace DESCRIBES a source file — it is derived FROM the code — so mining one for rules turns "this module
 * parses tokens" into a rule about how the project should be written. It is the code talking back to itself.
 */
describe("what cannot be a rule whatever it contains", () => {
  it("never reads a trace", () => {
    const { candidates, skipped } = sortProjectDocs([f(".horsecode/traces/src/a.ts.md"), f("docs/real.md")]);
    expect(candidates.map((c) => c.path)).toEqual(["docs/real.md"]);
    expect(skipped[0].skipped).toMatch(/talking back to itself/);
  });

  it("leaves generated and vendored markdown alone", () => {
    const { candidates } = sortProjectDocs([
      f("graphify-out/GRAPH_REPORT.md", 387), f("node_modules/pkg/README.md"), f(".claude/worktrees/x/README.md"),
    ]);
    expect(candidates).toEqual([]);
  });
});

/**
 * A record of what happened is not a statement of how things are done. A dated file was true on its date; a
 * rule has no date. Reported with the reason rather than dropped silently, because a project that keeps its
 * standards in `docs/archive` gets the wrong answer here and the only way to argue with a judgement is to
 * see it.
 */
describe("history, told apart from convention", () => {
  it("sets aside dated files, archives, handoffs and pasted chats", () => {
    const { candidates, skipped } = sortProjectDocs([
      f("docs/archive/OLD-REVIEW.md"),
      f(".planning/HANDOFF-2026-06-02.md"),
      f("docs/RESUME-2026-05-23.md"),
      f(".design-handoff/system/chats/chat1.md"),
      f("CHANGELOG.md"),
      f("docs/architecture.md"),
    ]);
    expect(candidates.map((c) => c.path)).toEqual(["docs/architecture.md"]);
    expect(skipped).toHaveLength(5);
    expect(skipped.every((s) => !!s.skipped)).toBe(true);
  });

  /** A convention that merely mentions a year in its text is not dated — only the PATH is read. */
  it("judges the path, not the contents", () => {
    const { candidates } = sortProjectDocs([f("docs/coding-standards.md")]);
    expect(candidates).toHaveLength(1);
  });
});

/**
 * The number is the whole argument for asking first. On the project this came from, the unfiltered set was
 * 6.8 MB — roughly 850 classification calls to produce the 25 rules the consolidation keeps.
 */
describe("what it will cost", () => {
  it("counts a set in the extractor's own unit", () => {
    expect(totalBytes([f("a.md", 2), f("b.md", 6)])).toBe(8 * 1024);
    expect(classifyCalls(8 * 1024, 8_000)).toBe(2);
  });

  it("never reports a set as free", () => {
    expect(classifyCalls(10, 8_000)).toBe(1);
  });
});
