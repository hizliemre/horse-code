import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runRoleAgent, runToCompletion, type RoleAgentOptions } from "../../src/agent/loop.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, ChatEvent, Tool } from "../../src/core/types.js";

const safeEcho: Tool = {
  name: "echo",
  description: "returns",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function opts(provider: MockProvider, over: Partial<RoleAgentOptions> = {}): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "you are a test role",
    tools: registry(safeEcho),
    messages: [{ role: "user", content: "hello" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("runRoleAgent", () => {
  it("single turn: emits text-delta, ends with message.done", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hel" }, { type: "text-delta", text: "lo" }, { type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([
      { type: "message.delta", text: "hel" },
      { type: "message.delta", text: "lo" },
      { type: "message.done", message: { role: "assistant", content: "hello" } },
    ]);
  });

  it("systemPrompt and user message go into the first request", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await drain(runRoleAgent(opts(p)));
    expect(p.requests[0].messages).toEqual([
      { role: "system", content: "you are a test role" },
      { role: "user", content: "hello" },
    ]);
  });

  it("tool-call turn: tool runs, result is appended to the second request, then it ends", async () => {
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }],
    ]);
    const events = await drain(runRoleAgent(opts(p)));
    // tool.request + tool.result were emitted
    expect(events.some((e) => e.type === "tool.request")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    // the second request has the tool result message
    const secondMsgs = p.requests[1].messages;
    expect(secondMsgs).toContainEqual({ role: "tool", toolCallId: "c1", name: "echo", content: "echo:x" });
    // final event is the final assistant message
    expect(events.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "done" } });
  });

  it("provider error → emits error event and ends", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("when maxTurns is exceeded, emits error event and stops", async () => {
    const toolCallTurn: ChatEvent[] = [
      { type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } },
      { type: "done", finishReason: "tool_calls" },
    ];
    const p = new MockProvider([toolCallTurn, toolCallTurn, toolCallTurn, toolCallTurn, toolCallTurn]);
    const events = await drain(runRoleAgent(opts(p, { maxTurns: 3 })));
    expect(events.some((e) => e.type === "error" && e.message.includes("maximum turn"))).toBe(true);
    expect(p.requests.length).toBe(3);
  });

  it("previously aborted signal: emits abort event, provider is never called", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p, { signal: ac.signal })));
    expect(events).toEqual([{ type: "abort" }]);
    expect(p.requests.length).toBe(0);
  });
});

describe("runToCompletion", () => {
  it("returns the last assistant message", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "answer" }, { type: "done", finishReason: "stop" }]]);
    const msg = await runToCompletion(opts(p));
    expect(msg).toEqual({ role: "assistant", content: "answer" });
  });

  it("throws on error", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runToCompletion(opts(p))).rejects.toThrow("boom");
  });

  it("throws on a previously aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await expect(runToCompletion(opts(p, { signal: ac.signal }))).rejects.toThrow(/cancel/);
  });
});
