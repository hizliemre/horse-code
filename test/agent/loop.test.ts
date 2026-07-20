import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runRoleAgent, runToCompletion, type RoleAgentOptions } from "../../src/agent/loop.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, ChatEvent, Tool } from "../../src/core/types.js";

const safeEcho: Tool = {
  name: "echo",
  description: "döner",
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
    systemPrompt: "sen bir test rolüsün",
    tools: registry(safeEcho),
    messages: [{ role: "user", content: "merhaba" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("runRoleAgent", () => {
  it("tek turn: text-delta yayar, message.done ile biter", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "sel" }, { type: "text-delta", text: "am" }, { type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([
      { type: "message.delta", text: "sel" },
      { type: "message.delta", text: "am" },
      { type: "message.done", message: { role: "assistant", content: "selam" } },
    ]);
  });

  it("systemPrompt ve user mesajı ilk isteğe gider", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await drain(runRoleAgent(opts(p)));
    expect(p.requests[0].messages).toEqual([
      { role: "system", content: "sen bir test rolüsün" },
      { role: "user", content: "merhaba" },
    ]);
  });

  it("tool-call turn'ü: tool çalışır, sonuç ikinci isteğe eklenir, sonra biter", async () => {
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }],
    ]);
    const events = await drain(runRoleAgent(opts(p)));
    // tool.request + tool.result yayıldı
    expect(events.some((e) => e.type === "tool.request")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    // ikinci istekte tool sonucu mesajı var
    const secondMsgs = p.requests[1].messages;
    expect(secondMsgs).toContainEqual({ role: "tool", toolCallId: "c1", name: "echo", content: "echo:x" });
    // son event final assistant mesajı
    expect(events.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "bitti" } });
  });

  it("provider error → error event yayar ve biter", async () => {
    const p = new MockProvider([[{ type: "error", message: "patladı" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([{ type: "error", message: "patladı" }]);
  });
});

describe("runToCompletion", () => {
  it("son assistant mesajını döner", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "cevap" }, { type: "done", finishReason: "stop" }]]);
    const msg = await runToCompletion(opts(p));
    expect(msg).toEqual({ role: "assistant", content: "cevap" });
  });

  it("error'da fırlatır", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runToCompletion(opts(p))).rejects.toThrow("boom");
  });
});
