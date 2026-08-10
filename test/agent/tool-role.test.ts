import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { Telemetry, NO_TELEMETRY, setTelemetry } from "../../src/obs/telemetry.js";
import type { EventRecord } from "../../src/obs/telemetry.js";
import { MemorySink } from "../../src/obs/sink.js";
import { executeToolCalls } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { Recall } from "../../src/agent/recall.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { Tool } from "../../src/core/types.js";

/**
 * WHO called it, not only WHAT was called.
 *
 * Telemetry recorded a tool, its key and its status, and nothing about the agent. So a file read four times
 * in one run could not be told apart as one agent repeating itself — waste Recall should have caught — from
 * four agents each reading it once, which is correct, Recall being per-agent. That question came up twice in
 * one session and could not be answered either time.
 */

/** Named `read_file` deliberately: Recall only memoizes RECALLABLE tools, and that is the set it checks. */
const echo: Tool = {
  name: "read_file", description: "echoes", permissionLevel: "safe",
  parameters: z.object({ path: z.string() }),
  describe: (a) => ({ allowKey: "read_file", preview: String((a as { path: string }).path) }),
  run: async (a) => ({ content: `said ${(a as { path: string }).path}`, isError: false }),
};

afterEach(() => { setTelemetry(NO_TELEMETRY); });

async function callOnce(sink: MemorySink, role?: string): Promise<void> {
  setTelemetry(new Telemetry(sink, () => 0));
  const tools = new ToolRegistry();
  tools.register(echo);
  const gen = executeToolCalls(
    [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }],
    {
      tools,
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      cwd: ".", signal: new AbortController().signal,
      recall: new Recall(),
      ...(role ? { role } : {}),
    },
  );
  let n = await gen.next();
  while (!n.done) n = await gen.next();
}

const events = (s: MemorySink): EventRecord[] =>
  s.records.filter((r): r is EventRecord => r.kind === "event");
const attrOf = (s: MemorySink, name: string): Record<string, unknown> =>
  events(s).find((e) => e.name === name)?.attributes ?? {};

describe("tool telemetry carries the role", () => {
  it("records who made the call", async () => {
    const sink = new MemorySink();
    await callOnce(sink, "code-reviewer");
    expect(attrOf(sink, "tool.result")["hc.role"]).toBe("code-reviewer");
  });

  it("records it on a recalled call too — that is the one the attribution is FOR", async () => {
    setTelemetry(new Telemetry(new MemorySink(), () => 0));
    const sink = new MemorySink();
    const tools = new ToolRegistry();
    tools.register(echo);
    const recall = new Recall();
    const deps = {
      tools,
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async (): Promise<boolean> => true,
      cwd: ".", signal: new AbortController().signal,
      recall, role: "implementer",
    };
    const call = [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }];
    setTelemetry(new Telemetry(sink, () => 0));
    for (let i = 0; i < 2; i++) {          // second call is answered from the memo
      const gen = executeToolCalls(call, deps);
      let n = await gen.next();
      while (!n.done) n = await gen.next();
    }
    expect(attrOf(sink, "tool.recalled")["hc.role"]).toBe("implementer");
  });

  it("omits the attribute rather than inventing one when no role is set", async () => {
    const sink = new MemorySink();
    await callOnce(sink);
    expect(attrOf(sink, "tool.result")).not.toHaveProperty("hc.role");
  });
});

describe("a resolved role carries its own name", () => {
  it("so every caller that spreads it hands the name to the agent", () => {
    const registry = new RoleRegistry(
      { "code-reviewer": { models: ["m"], systemPrompt: "P" } }, {}, new SkillRegistry());
    expect(registry.resolve("code-reviewer").role).toBe("code-reviewer");
  });
});
