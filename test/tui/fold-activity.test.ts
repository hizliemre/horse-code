import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";
import { flattenTool } from "../../src/tui/lines.js";
import type { ToolActivity } from "../../src/core/types.js";

const act = (tool: string, target: string, ok = true): ToolActivity =>
  ({ tool, target, lines: 0, summary: ok ? "done" : "no such file", ok });

const rows = (c: TuiController): ToolActivity[] =>
  c.state.transcript.filter((x): x is { kind: "tool"; activity: ToolActivity } => "kind" in x)
    .map((x) => x.activity);

const render = (a: ToolActivity): string =>
  flattenTool(a, 100).map((l) => l.map((s) => s.text).join("")).join("");

/**
 * Every executed tool reaching the chat was the right call — the record of what an agent did was being lost.
 * But a planning agent reads the same two files sixty times, and sixty rows of `read_file(spec.md) · ---`
 * bury the handful that carry information: the failures, and the searches that found nothing.
 */
describe("a run of calls to one tool becomes one row", () => {
  it("folds consecutive calls and counts them", () => {
    const c = new TuiController();
    for (let i = 0; i < 5; i++) c.pushActivity(act("read_file", "spec.md"));
    expect(rows(c)).toHaveLength(1);
    expect(render(rows(c)[0])).toContain("read_file ×5");
  });

  it("keeps each distinct target, busiest first", () => {
    const c = new TuiController();
    for (const t of ["a.md", "b.md", "a.md", "a.md", "b.md"]) c.pushActivity(act("read_file", t));
    const line = render(rows(c)[0]);
    expect(line).toContain("read_file ×5");
    expect(line.indexOf("a.md")).toBeLessThan(line.indexOf("b.md"));
    expect(line).toContain("a.md ×3");
  });

  it("starts a new row when the tool changes", () => {
    const c = new TuiController();
    c.pushActivity(act("read_file", "a.md"));
    c.pushActivity(act("grep", "foo"));
    c.pushActivity(act("read_file", "b.md"));
    expect(rows(c)).toHaveLength(3);
  });

  /**
   * A failure ends the run and gets its own row. It is the thing worth seeing, and averaging it into a count
   * is exactly how it would stop being noticed.
   */
  it("never folds a failure into a run", () => {
    const c = new TuiController();
    c.pushActivity(act("read_file", "a.md"));
    c.pushActivity(act("read_file", "a.md", false));
    c.pushActivity(act("read_file", "a.md"));
    expect(rows(c)).toHaveLength(3);
    expect(rows(c)[1].ok).toBe(false);
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

  // Sixty rows of one tool must not become sixty target names either.
  it("caps how many targets it names", () => {
    const c = new TuiController();
    for (let i = 0; i < 12; i++) c.pushActivity(act("read_file", `file-${i}.md`));
    const line = render(rows(c)[0]);
    expect(line).toContain("read_file ×12");
    expect(line).toContain("+9 more");
  });

  /** A long path says more from its tail: the file, not the numbered feature directory it sits in. */
  it("keeps the tail of a long path", () => {
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
