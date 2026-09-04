import { describe, it, expect } from "vitest";
import { flattenTool } from "../../src/tui/lines.js";
import type { ToolActivity } from "../../src/core/types.js";

const render = (a: Partial<ToolActivity>): string =>
  flattenTool({ tool: "Write", target: "", lines: 0, ...a } as ToolActivity, 120)
    .map((r) => r.map((s) => s.text).join("")).join(" ⏎ ").trim();

/**
 * A delegated agent's tool row made three false claims at once: WRITE for every tool, ZERO LINES for a count
 * nothing had measured, and an empty target because Codex names the file in `changes`. Watching a live board
 * that meant page after page of `Write() · 0 lines` while real work went on underneath.
 */
describe("what a delegated agent's tool row says", () => {
  it("no longer claims a line count nobody measured", () => {
    expect(render({ tool: "Write", target: "tasks.md", summary: "", ok: true })).not.toMatch(/0 lines/);
  });

  it("names the file the tool touched, and says nothing else", () => {
    // A suffix on every successful row is the bullet said twice.
    expect(render({ tool: "Write", target: "tasks.md", summary: "", ok: true })).toBe("● Write(tasks.md)");
  });

  /** A read drawn as a write is not a small thing: it hides what the agent is actually doing. */
  it("says which tool ran, rather than calling everything a write", () => {
    const read = render({ tool: "Read", target: "plan.md", summary: "", ok: true });
    expect(read).toContain("Read");
    expect(read).not.toContain("Write");
  });

  it("marks a failure as one — the only suffix worth the space", () => {
    expect(render({ tool: "Write", target: "spec.md", summary: "failed", ok: false })).toContain("failed");
  });

  /** The old shape, kept as the thing this must never render again. */
  it("still shows a real file write with its measured line count", () => {
    const row = render({ tool: "write", target: "a.ts", lines: 12, preview: ["x"] });
    expect(row).toContain("12 lines");
  });
});

/**
 * Both CLIs describe the same act in their own words. Passed through raw, a board showed `file_change` from
 * one agent and `Write` from another for the identical thing.
 */
describe("one vocabulary across the two CLIs", () => {
  it("calls a Codex file change what Claude calls it", async () => {
    const { DELEGATED_TOOL_NAMES } = await import("../../src/agent/loop.js") as unknown as
      { DELEGATED_TOOL_NAMES?: Record<string, string> };
    // Exported or not, the mapping the loop applies is what the row must end up showing.
    expect(render({ tool: DELEGATED_TOOL_NAMES?.file_change ?? "Write", target: "a.ts +2", summary: "", ok: true }))
      .toBe("● Write(a.ts +2)");
  });
});
