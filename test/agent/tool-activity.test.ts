import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Tool, ToolActivity } from "../../src/core/types.js";
import { flattenTool } from "../../src/tui/lines.js";

/** A tool that reports nothing of its own — a lookup, a search, the common case. */
const quiet = (name: string, content: string, isError = false): Tool => ({
  name,
  description: "d",
  permissionLevel: "safe",
  parameters: z.object({ path: z.string().optional(), pattern: z.string().optional() }),
  describe: () => ({ allowKey: name, preview: name }),
  async run() { return { content, isError }; },
});

/** A tool that reports its own activity, as write/edit do. */
const loud: Tool = {
  name: "write_file",
  description: "d",
  permissionLevel: "write",
  parameters: z.object({ path: z.string() }),
  describe: () => ({ allowKey: "write", preview: "write" }),
  async run(_args, ctx) {
    ctx.onActivity?.({ tool: "write", target: "a.ts", lines: 3, preview: ["x", "y", "z"], startLine: 1 });
    return { content: "written", isError: false };
  },
};

const run = async (tools: Tool[], calls: { id: string; name: string; arguments: string }[]) => {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  const seen: ToolActivity[] = [];
  const gen = executeToolCalls(calls, {
    tools: reg,
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    onActivity: (a: ToolActivity) => seen.push(a),
  } as never);
  for (;;) { const n = await gen.next(); if (n.done) break; }
  return seen;
};

describe("every executed tool lands in the chat", () => {
  /**
   * The failure this fixes: a read or a search surfaced only in the transient line under the progress
   * indicator and then vanished, so the record of what an agent actually did was lost.
   */
  it("reports a tool that reports nothing of its own", async () => {
    const seen = await run([quiet("grep", "12 matches in 4 files")],
      [{ id: "1", name: "grep", arguments: JSON.stringify({ pattern: "foo" }) }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: "grep", target: "foo", summary: "12 matches in 4 files", ok: true });
  });

  // Otherwise a write would appear twice: once with its diff, once as a bare line.
  it("does not double-report a tool that reported itself", async () => {
    const seen = await run([loud], [{ id: "1", name: "write_file", arguments: JSON.stringify({ path: "a.ts" }) }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].preview).toEqual(["x", "y", "z"]);
    expect(seen[0].summary).toBeUndefined();
  });

  it("marks a failed call so it is not mistaken for a successful one", async () => {
    const seen = await run([quiet("read_file", "no such file", true)],
      [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: "nope.ts" }) }]);
    expect(seen[0]).toMatchObject({ ok: false, target: "nope.ts" });
  });

  it("picks the argument that says what the call was about", async () => {
    const seen = await run([quiet("graph_impact", "affects 3 symbols")],
      [{ id: "1", name: "graph_impact", arguments: JSON.stringify({ pattern: "loadConfig" }) }]);
    expect(seen[0].target).toBe("loadConfig");
  });

  it("reports every call in a multi-tool turn", async () => {
    const seen = await run([quiet("grep", "a"), quiet("glob", "b")], [
      { id: "1", name: "grep", arguments: JSON.stringify({ pattern: "x" }) },
      { id: "2", name: "glob", arguments: JSON.stringify({ pattern: "y" }) },
    ]);
    expect(seen.map((s) => s.tool).sort()).toEqual(["glob", "grep"]);
  });

  it("truncates a long outcome rather than pasting a whole result into the chat", async () => {
    const seen = await run([quiet("shell", "x".repeat(500))],
      [{ id: "1", name: "shell", arguments: JSON.stringify({ pattern: "ls" }) }]);
    expect(seen[0].summary!.length).toBeLessThanOrEqual(120);
  });

  it("an empty result is still reported, just without an outcome", async () => {
    const seen = await run([quiet("glob", "")], [{ id: "1", name: "glob", arguments: JSON.stringify({ pattern: "*" }) }]);
    expect(seen[0].summary).toBe("");
  });
});

describe("rendering", () => {
  it("a summary activity is ONE line, so a busy turn does not flood the chat", () => {
    const lines = flattenTool({ tool: "grep", target: "foo", lines: 0, summary: "12 matches", ok: true }, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((s) => s.text).join("")).toContain("grep(foo)");
  });

  it("a file activity still renders its diff", () => {
    const lines = flattenTool({ tool: "write", target: "a.ts", lines: 2, preview: ["one", "two"], startLine: 1 }, 80);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("a failed call is coloured differently from a successful one", () => {
    const bad = flattenTool({ tool: "read_file", target: "x", lines: 0, summary: "no such file", ok: false }, 80);
    const good = flattenTool({ tool: "read_file", target: "x", lines: 0, summary: "ok", ok: true }, 80);
    expect(bad[0][0].color).not.toBe(good[0][0].color);
  });
});
