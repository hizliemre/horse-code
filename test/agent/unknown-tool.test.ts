import { describe, it, expect } from "vitest";
import { unknownTool, resolveByShape, executeToolCalls, brokenArguments } from "../../src/agent/tool-exec.js";
import { Telemetry, setTelemetry, NO_TELEMETRY } from "../../src/obs/telemetry.js";
import { MemorySink } from "../../src/obs/sink.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";

/**
 * Observed on a real run: a project-manager invented an MCP tool that was never registered for it, and spent
 * SEVEN turns extending the name one fragment at a time — `…list_projects_ide`, `…_9564507f_ide`,
 * `…_9564507f2f_ide`, `…_9564507f2f430e1e52_ide` — before the phase died without writing its file. 133
 * minutes and 18M input tokens, ended by a message that had the answer and did not give it: the entire text
 * was `unknown tool: <name>`.
 */
describe("unknown tool: the message a model can act on", () => {
  const TOOLS = ["read_file", "write_file", "grep", "glob", "git", "submit"];

  it("names the closest tool when the name is a near miss", () => {
    expect(unknownTool("read_files", TOOLS)).toContain("Did you mean `read_file`");
  });

  /**
   * The first version ranked by leading characters, which is right for a truncated name and useless for the
   * mistake that recurs: a model reaching for `read_file` and writing `view_file`. Measured live — four
   * attempts at `view_file` in one run, with the suggester offering nothing for it, nor for `open_file` or
   * `list_files`. The differing letters are at the FRONT, exactly where a prefix match looks.
   */
  it("sees a near miss whose difference is at the front of the word", () => {
    for (const wrong of ["view_file", "open_file", "list_files"]) {
      expect(unknownTool(wrong, TOOLS), wrong).toMatch(/Did you mean .*read_file|Did you mean .*write_file/);
    }
  });

  it("offers several when several are equally close, rather than a guess dressed as an answer", () => {
    const msg = unknownTool("view_file", TOOLS);
    expect(msg).toContain(" or ");
  });

  it("lists what exists, always — 'no such tool' is only useful beside 'these do'", () => {
    const msg = unknownTool("mcp_angular_cli_list_projects_9564507f2f430e1e52_ide", TOOLS);
    for (const t of TOOLS) expect(msg).toContain(t);
  });

  it("tells it not to guess, which is what it did seven times", () => {
    expect(unknownTool("whatever", TOOLS)).toMatch(/do not guess/i);
  });

  it("offers no suggestion when nothing is close, rather than a misleading one", () => {
    expect(unknownTool("zzzzzz", TOOLS)).not.toContain("Did you mean");
  });

  it("survives an empty toolset without pretending something is close", () => {
    const msg = unknownTool("anything", []);
    expect(msg).toContain("unknown tool: anything");
    expect(msg).not.toContain("Did you mean");
  });
});

/**
 * The remainder of a stream that stopped part-way through a call's arguments.
 *
 * The transport turns that into a retry while nothing has streamed yet (see src/providers/omniroute.ts).
 * When prose was already out the turn cannot be re-run, and what the model is told is all that is left.
 *
 * Measured live: `cx/gpt-5.6-luna-max` lost 155 seconds of a `write_file` this way and was handed the whole
 * of "arguments are invalid JSON" — no tool name, no word on whether anything had been written, and no
 * reason to do anything differently the second time.
 */
describe("what a model is told when its arguments arrive cut off", () => {
  it("says nothing ran — an interrupted write leaves no way to know", () => {
    expect(brokenArguments("{")).toMatch(/nothing was written/i);
  });

  /**
   * The count is of the ARGUMENTS. Written with the tool name in that position instead, the message reported
   * the length of the word `write_file` as the size of a truncated document — and nothing failed at runtime,
   * because both are strings. `npm run typecheck` had the answer; neither `tsup` nor `vitest` runs it.
   */
  it("counts the characters that arrived, not something else the call carries", () => {
    expect(brokenArguments('{"path":"a.ts"}')).toContain("15 characters");
  });

  it("says what to do differently, since repeating it verbatim is what failed", () => {
    expect(brokenArguments('{"path":"spec.md","content":"# Sp')).toMatch(/smaller calls/i);
  });

  /** The tool's name comes from errResult, which prefixes every message it delivers — see tool-exec.test.ts. */
  it("does not repeat the tool name that the delivery already carries", () => {
    expect(brokenArguments("{")).not.toContain("write_file");
  });
});

describe("a call that never ran still happened", () => {
  /**
   * Only the executing path was recorded, so a call to a tool that does not exist left NOTHING in the
   * telemetry. Found while diagnosing a run that died after seven such turns: the log showed model calls
   * with shrinking output and no tool activity between them, which reads as "the model stopped calling
   * tools" — the opposite of what happened. Measuring that absence proved nothing, and nearly led to the
   * conclusion that the fix did not apply to the failure it was written for.
   */
  it("records an unknown tool in the telemetry", async () => {
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));
    try {
      const gen = executeToolCalls(
        [{ id: "1", name: "mcp_angular_cli_list_projects_9564507f2f430e1e52_ide", arguments: "{}" }],
        {
          tools: new ToolRegistry(),
          permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
          approve: async () => true,
          cwd: ".",
          signal: new AbortController().signal,
        } as never,
      );
      for await (const _ of gen) { /* drain */ }
      const events = sink.records.filter((e) => e.name === "tool.result");
      expect(events.length).toBe(1);
      expect(events[0].attributes["hc.tool"]).toContain("9564507f");
      expect(events[0].attributes["hc.outcome"]).toBe("unknown-or-invalid");
    } finally { setTelemetry(NO_TELEMETRY); }
  });
});

describe("a name that differs only in punctuation is the same name", () => {
  /**
   * MCP tools register as `mcp__<server>__<tool>`, and a server name may contain a hyphen. Models rewrite
   * that as `mcp_angular_cli_list_projects` with dependable regularity — measured twice in one run, and in
   * an earlier run it cost seven turns and the phase's entire output. Strip the punctuation from both and
   * they are the same string, so there is nothing to disambiguate.
   */
  const TOOLS = ["read_file", "mcp__angular-cli__list_projects", "mcp__angular-cli__search_documentation"];

  it("resolves the mangling that actually happens", () => {
    expect(resolveByShape("mcp_angular_cli_list_projects", TOOLS)).toBe("mcp__angular-cli__list_projects");
    expect(resolveByShape("MCP__ANGULAR-CLI__LIST_PROJECTS", TOOLS)).toBe("mcp__angular-cli__list_projects");
  });

  it("refuses when two tools would normalise alike — that is a real ambiguity", () => {
    expect(resolveByShape("read_file", ["read_file", "readfile"])).toBeUndefined();
  });

  it("does not rescue a name that is simply wrong", () => {
    // `view_file` is not `read_file` with different punctuation; it is a different word, and was also seen.
    expect(resolveByShape("view_file", TOOLS)).toBeUndefined();
  });

  it("runs the tool when the call differs only in punctuation", async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register({
      name: "mcp__angular-cli__list_projects", description: "d", permissionLevel: "safe",
      parameters: { safeParse: () => ({ success: true, data: {} }) } as never,
      run: async () => { ran = true; return { content: "ok", isError: false }; },
    } as never);
    const gen = executeToolCalls([{ id: "1", name: "mcp_angular_cli_list_projects", arguments: "{}" }], {
      tools: registry,
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      cwd: ".", signal: new AbortController().signal,
    } as never);
    for await (const _ of gen) { /* drain */ }
    expect(ran).toBe(true);
  });
});

/**
 * Which AGENT called it, not just which role.
 *
 * A role is run many times over, so `read_file` on one path four times under `planner` reads the same in the
 * log whether it was one agent repeating itself — waste the memo should have caught, and a defect — or four
 * agents each asking once, which is correct. Both were live possibilities in the same run and nothing
 * recorded could separate them; two diagnoses stopped at exactly that question before this existed.
 */
describe("who made the call", () => {
  it("stamps the calling agent on the record", async () => {
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));
    try {
      const gen = executeToolCalls([{ id: "1", name: "nope", arguments: "{}" }], {
        tools: new ToolRegistry(),
        permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
        approve: async () => true,
        cwd: ".",
        signal: new AbortController().signal,
        role: "planner",
        agentId: "a7",
      } as never);
      for await (const _ of gen) { /* drain */ }
      const e = sink.records.find((r) => r.name === "tool.result");
      expect(e!.attributes["hc.role"]).toBe("planner");
      expect(e!.attributes["hc.agent"]).toBe("a7");
    } finally { setTelemetry(NO_TELEMETRY); }
  });

  /** Counted, so a replayed trace gives the same ids and they sort into the order the agents started. */
  it("names agents in the order they start", async () => {
    const { nextAgentId } = await import("../../src/agent/loop.js");
    const a = nextAgentId();
    const b = nextAgentId();
    expect(a).toMatch(/^a\d+$/);
    expect(Number(b.slice(1))).toBe(Number(a.slice(1)) + 1);
  });
});
