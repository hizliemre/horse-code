import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";
import { flattenTool } from "../../src/tui/lines.js";
import type { ToolActivity } from "../../src/core/types.js";

const act = (tool: string, target: string, ok = true): ToolActivity =>
  ({ tool, target, lines: 0, summary: ok ? "done" : "no such file", ok });

const rows = (c: TuiController): ToolActivity[] =>
  c.getState().transcript.filter((x): x is { kind: "tool"; activity: ToolActivity } => "kind" in x)
    .map((x) => x.activity);

const render = (a: ToolActivity): string =>
  flattenTool(a, 100).map((l) => l.map((s) => s.text).join("")).join("");

/**
 * Every executed tool reaching the chat was the right call — the record of what an agent did was being lost.
 * But a planning agent reads the same two files sixty times, and sixty rows of `read_file(spec.md) · ---`
 * bury the one thing the user is actually reading: the answer those calls were made to produce.
 *
 * While the run goes it says how many and what is in flight; once anything else is said, it is one line.
 */
describe("a run of calls to one tool becomes one row", () => {
  it("folds consecutive calls and counts them", () => {
    const c = new TuiController();
    for (let i = 0; i < 5; i++) c.pushActivity(act("read_file", "spec.md"));
    expect(rows(c)).toHaveLength(1);
    expect(render(rows(c)[0])).toContain("Running 5 read_file calls…");
  });

  it("shows the call in flight, and nothing else", () => {
    const c = new TuiController();
    for (const t of ["a.md", "b.md", "a.md", "a.md", "c.md"]) c.pushActivity(act("read_file", t));
    const line = render(rows(c)[0]);
    expect(line).toContain("Running 5 read_file calls…");
    expect(line).toContain("c.md");     // …the one it is on now
    expect(line).not.toContain("a.md"); // …not a list of everything it has been on
  });

  /** Once the answer arrives, the work behind it is one quiet line. */
  it("settles to a past-tense line as soon as anything else is said", () => {
    const c = new TuiController();
    for (let i = 0; i < 6; i++) c.pushActivity(act("shell", "git status"));
    c.note("here is what I found");
    expect(render(rows(c)[0])).toBe("● Ran 6 shell commands");
  });

  it("calls a shell run commands, and everything else calls", () => {
    const c = new TuiController();
    for (let i = 0; i < 2; i++) c.pushActivity(act("grep", "needle"));
    c.note("done");
    expect(render(rows(c)[0])).toContain("Ran 2 grep calls");
  });

  it("starts a new row when the tool changes", () => {
    const c = new TuiController();
    c.pushActivity(act("read_file", "a.md"));
    c.pushActivity(act("grep", "foo"));
    c.pushActivity(act("read_file", "b.md"));
    expect(rows(c)).toHaveLength(3);
  });

  /**
   * A failure is kept as a COUNT on the row rather than as a row of its own.
   *
   * Breaking the run for each failure was right about what matters and wrong about what it cost: measured
   * live, four rejected searches and the four shell commands they were retried with filled the screen, and
   * the answer they were made to produce was pushed off it. One line says the same thing.
   */
  it("counts failures on the run instead of breaking it", () => {
    const c = new TuiController();
    c.pushActivity(act("read_file", "a.md"));
    c.pushActivity(act("read_file", "a.md", false));
    c.pushActivity(act("read_file", "a.md", false));
    c.note("done");
    expect(rows(c)).toHaveLength(1);
    const line = render(rows(c)[0]);
    expect(line).toContain("Ran 3 read_file calls");
    expect(line).toContain("2 failed");
  });

  it("marks a run that had failures in red, so a count is not a quiet count", () => {
    const c = new TuiController();
    c.pushActivity(act("grep", "a"));
    c.pushActivity(act("grep", "b", false));
    c.note("done");
    expect(flattenTool(rows(c)[0], 100)[0][0].color).toBe("red");
  });

  it("renders a failure in its own colour, not the run's", () => {
    const failed = act("read_file", "a.md", false);
    expect(flattenTool(failed, 100)[0][0].color).toBe("red");
  });

  /** A write's content is the point of the row; folding it away would lose the diff. */
  it("never folds a file write", () => {
    const c = new TuiController();
    const write: ToolActivity = { tool: "write", target: "a.ts", lines: 2, preview: ["x", "y"], startLine: 1 };
    c.pushActivity(write);
    c.pushActivity(write);
    expect(rows(c)).toHaveLength(2);
  });

  it("leaves a single call rendered as itself, with its outcome", () => {
    const c = new TuiController();
    c.pushActivity(act("grep", "needle"));
    expect(render(rows(c)[0])).toBe("● grep(needle)  · done");
  });

  it("stays one line however many calls it stands for", () => {
    const c = new TuiController();
    for (let i = 0; i < 60; i++) c.pushActivity(act("read_file", `file-${i}.md`));
    c.note("done");
    expect(flattenTool(rows(c)[0], 100)).toHaveLength(1);
    expect(render(rows(c)[0])).toContain("Ran 60 read_file calls");
  });

  /** A long path says more from its tail: the file, not the numbered feature directory it sits in. */
  it("keeps the tail of a long path while it is in flight", () => {
    const c = new TuiController();
    const long = "specs/001-build-luxury-todo-app/very/deep/nesting/here/spec.md";
    c.pushActivity(act("read_file", long));
    c.pushActivity(act("read_file", long));
    expect(render(rows(c)[0])).toContain("spec.md");
  });

  /** The newest outcome wins: a summary of the run's last call beats a stale first one. */
  it("carries the latest summary", () => {
    const c = new TuiController();
    c.pushActivity({ tool: "grep", target: "a", lines: 0, summary: "old", ok: true });
    c.pushActivity({ tool: "grep", target: "b", lines: 0, summary: "new", ok: true });
    expect(rows(c)[0].summary).toBe("new");
  });
});
