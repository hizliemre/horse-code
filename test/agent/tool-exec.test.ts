import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls, outcome, type ToolExecResult } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, Tool, ToolCall } from "../../src/core/types.js";

// Simple fake tools
const safeEcho: Tool = {
  name: "echo",
  description: "returns the input",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
const writeTool: Tool = {
  name: "w",
  description: "writes",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: (a) => ({ allowKey: String(a.p), preview: `write ${a.p}` }),
  run: async (a) => ({ content: `wrote:${a.p}`, isError: false }),
};
const throwsDescribe: Tool = {
  name: "bad",
  description: "describe throw",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: () => { throw new Error("describe threw"); },
  run: async () => ({ content: "x", isError: false }),
};

function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
function call(id: string, name: string, args: object): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
async function drainGen(
  gen: AsyncGenerator<AgentEvent, ToolExecResult[], void>,
): Promise<{ events: AgentEvent[]; result: ToolExecResult[] }> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}
const deps = (over: Partial<Parameters<typeof executeToolCalls>[1]>) => ({
  tools: registry(safeEcho, writeTool, throwsDescribe),
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
});

const writeFile: Tool = { name: "write_file", description: "w", permissionLevel: "write", parameters: z.object({ path: z.string() }), describe: (a) => ({ allowKey: String(a.path), preview: "w" }), run: async () => ({ content: "ok", isError: false }) };
const editFile: Tool = { name: "edit_file", description: "e", permissionLevel: "write", parameters: z.object({ path: z.string() }), describe: (a) => ({ allowKey: String(a.path), preview: "e" }), run: async () => ({ content: "ok", isError: false }) };
const failWrite: Tool = { name: "write_file", description: "w", permissionLevel: "write", parameters: z.object({ path: z.string() }), describe: (a) => ({ allowKey: String(a.path), preview: "w" }), run: async () => ({ content: "disk full", isError: true }) };

const shell: Tool = {
  name: "shell",
  description: "runs a command",
  permissionLevel: "exec",
  parameters: z.object({ command: z.string() }),
  describe: (a) => ({ allowKey: String(a.command), preview: String(a.command) }),
  run: async (a) => ({ content: `ran:${a.command}`, isError: false }),
};

describe("executeToolCalls permission re-check at execution time", () => {
  it("a mid-batch switch to auto applies to still-queued asks (stops nagging immediately)", async () => {
    // Two exec calls in ONE turn are both planned as "ask" (mode=ask). While approving the first, the user
    // switches to auto → the second must auto-run WITHOUT a prompt.
    const permission = new PermissionEngine({ mode: "ask", allowlist: [] });
    const prompted: string[] = [];
    const { events, result } = await drainGen(executeToolCalls(
      [call("1", "shell", { command: "mkdir -p src" }), call("2", "shell", { command: "npm install" })],
      deps({
        tools: registry(shell),
        permission,
        approve: async (req) => { prompted.push(req.allowKey); permission.setMode("auto"); return true; }, // approve #1 + flip to auto
      }),
    ));
    expect(prompted).toEqual(["mkdir -p src"]); // only the FIRST asked; the second auto-allowed after the switch
    expect(events.filter((e) => e.type === "permission.ask")).toHaveLength(1);
    expect(result.map((r) => r.result.content)).toEqual(["ran:mkdir -p src", "ran:npm install"]); // both actually ran
  });
});

describe("executeToolCalls onWrite (per-file commit hook)", () => {
  it("fires sequentially after each successful write_file/edit_file, with the path", async () => {
    const written: string[] = [];
    await drainGen(executeToolCalls(
      [call("1", "write_file", { path: "a.ts" }), call("2", "edit_file", { path: "b.ts" }), call("3", "echo", { t: "x" })],
      deps({ tools: registry(safeEcho, writeFile, editFile), onWrite: async (p) => { written.push(p); } }),
    ));
    expect(written).toEqual(["a.ts", "b.ts"]); // both writes committed, echo ignored
  });

  it("does NOT fire for a failed write", async () => {
    const written: string[] = [];
    await drainGen(executeToolCalls(
      [call("1", "write_file", { path: "a.ts" })],
      deps({ tools: registry(failWrite), onWrite: async (p) => { written.push(p); } }),
    ));
    expect(written).toEqual([]); // isError result → no commit
  });
});

describe("executeToolCalls", () => {
  it("safe tool runs automatically, result returned in call order", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "echo", { t: "hi" })], deps({})));
    expect(result).toEqual([{ id: "1", name: "echo", result: { content: "echo:hi", isError: false } }]);
  });

  it("write tool runs in auto mode", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "w", { p: "a.ts" })], deps({})));
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("ask mode: denied when approve=false (not executed)", async () => {
    const { events, result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => false,
      })),
    );
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("denied");
    expect(events.some((e) => e.type === "permission.ask")).toBe(true);
  });

  it("ask mode: runs when approve=true", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => true,
      })),
    );
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("unknown tool → error result", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "missing", {})], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("unknown tool");
  });

  it("empty tool-call id → error result (not executed)", async () => {
    const { result } = await drainGen(executeToolCalls([call("", "echo", { t: "x" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("invalid tool-call id");
  });

  it("describe throws → error result (not executed)", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "bad", { p: "a" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("describe");
  });

  it("multiple safe tools run in parallel, result in call order", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "echo", { t: "a" }), call("2", "echo", { t: "b" })], deps({})),
    );
    expect(result.map((r) => r.result.content)).toEqual(["echo:a", "echo:b"]);
  });

  it("malformed JSON argument → error result (not executed)", async () => {
    const badCall = { id: "1", name: "echo", arguments: "{not json" };
    const { result } = await drainGen(executeToolCalls([badCall], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("invalid JSON");
  });
});

/**
 * A shell result opens with `$ <command>` so the model's transcript records what ran.
 *
 * The chat line already names the command — it IS the bold part — so taking that first line as the summary
 * printed the same command twice on one line and pushed out the only new thing there was. On a run making
 * six hundred calls, that doubling is most of what makes the flow tiring to read.
 */
describe("outcome", () => {
  const res = (content: string) => ({ content, isError: false });

  it("skips the shell echo and reports what the command said", () => {
    expect(outcome(res("$ wc -l styles.css\n     412 styles.css"), "wc -l styles.css")).toBe("412 styles.css");
  });

  it("keeps a line that merely starts with $ but is not the echo", () => {
    expect(outcome(res("$ echo hi\n$ PATH is unset"), "echo hi")).toBe("$ PATH is unset");
  });

  it("says nothing when the command produced nothing but its own echo", () => {
    expect(outcome(res("$ touch a.txt\n"), "touch a.txt")).toBe("");
  });

  it("is unchanged for a tool that does not echo", () => {
    expect(outcome(res("140 lines"), "src/a.ts")).toBe("140 lines");
  });

  /** The subject is truncated at 60 chars with an ellipsis; the echo it came from is not. */
  it("still matches when the shown command was truncated", () => {
    const cmd = "cd /private/tmp/wsrepo && grep -n \"^:root\\\\[data-theme\" packages/simpleui/src/styles.css";
    expect(outcome(res(`$ ${cmd}\n12: :root[data-theme]`), `${cmd.slice(0, 59)}…`)).toBe("12: :root[data-theme]");
  });

  it("does not strip anything when there is no subject to match", () => {
    expect(outcome(res("$ something\nrest"))).toBe("$ something");
  });
});

/**
 * A successful read's summary was the first line of whatever sat at that offset — `import { defineConfig }`,
 * `<!--`, a stray brace. It said nothing about the read and crowded out the file's own name.
 */
describe("a successful read leaves no second column", () => {
  const activityFor = async (name: string, content: string, isError = false) => {
    const seen: { summary?: string; ok?: boolean }[] = [];
    const reg = registry({
      name, description: "d", permissionLevel: "safe", parameters: z.object({ path: z.string() }),
      run: async () => ({ content, isError }),
    } as unknown as Tool);
    await drainGen(executeToolCalls(
      [call("c1", name, { path: "src/a.ts" })],
      deps({ tools: reg, onActivity: (a) => seen.push({ summary: a.summary, ok: a.ok }) }),
    ));
    return seen[0];
  };

  it("says nothing extra about a read that worked", async () => {
    expect((await activityFor("read_file", "   1  import { defineConfig } from 'vitest/config';"))?.summary).toBe("");
  });

  it("still reports a read that did not", async () => {
    const a = await activityFor("read_file", "offset 560 is past the end of the file (473 lines).", true);
    expect(a?.summary).toContain("past the end");
    expect(a?.ok).toBe(false);
  });

  it("leaves every other tool's outcome alone — a grep's match is the point", async () => {
    expect((await activityFor("grep", "src/a.ts:12: const x = 1;"))?.summary).toBe("src/a.ts:12: const x = 1;");
  });
});

/**
 * No tool result may become the conversation.
 *
 * Each tool bounds its own output, and each bound was a count rather than a size: `grep` capped MATCHES, and
 * a match is a line with no length limit. Measured on a real project, one line of `graphify-out/graph.json`
 * is 35,272,070 characters, and a live brainstormer's prompt reached 3,397,616 in a single call.
 *
 * That particular hole is closed where it was made. This is the floor under all of them: a tool added later,
 * or an MCP server nobody here wrote, cannot do the same thing again.
 */
describe("the ceiling under every tool result", () => {
  it("cuts an oversized result and says so", async () => {
    const { capToolResult, MAX_TOOL_RESULT_CHARS } = await import("../../src/agent/tool-exec.js");
    const huge = "x".repeat(MAX_TOOL_RESULT_CHARS * 3);
    const out = capToolResult(huge, "some_tool");
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 300);
    expect(out).toMatch(/some_tool/);
    expect(out).toMatch(/truncated|cut/i);
    expect(out.startsWith("x")).toBe(true);   // …the beginning, which is the part a reader wants
  });

  it("leaves an ordinary result exactly as it was", async () => {
    const { capToolResult } = await import("../../src/agent/tool-exec.js");
    expect(capToolResult("just a line of output", "t")).toBe("just a line of output");
    expect(capToolResult("", "t")).toBe("");
  });
});
