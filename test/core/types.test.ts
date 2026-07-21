import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Tool, Message, ChatEvent, AgentEvent } from "../../src/core/types.js";
import { isTextDelta, isToolCallEvent } from "../../src/core/types.js";

describe("core types", () => {
  it("Tool interface accepts an object compatible with zod parameters", async () => {
    const tool: Tool = {
      name: "echo",
      description: "returns the input",
      permissionLevel: "safe",
      parameters: z.object({ text: z.string() }),
      run: async (args) => ({ content: String(args.text), isError: false }),
    };
    const result = await tool.run({ text: "hello" }, {
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ content: "hello", isError: false });
  });

  it("Message type can carry tool calls", () => {
    const msg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "echo", arguments: '{"text":"hi"}' }],
    };
    expect(msg.toolCalls?.[0].name).toBe("echo");
  });

  it("ChatEvent type guards discriminate correctly", () => {
    const delta: ChatEvent = { type: "text-delta", text: "x" };
    const call: ChatEvent = {
      type: "tool-call",
      toolCall: { id: "1", name: "echo", arguments: "{}" },
    };
    expect(isTextDelta(delta)).toBe(true);
    expect(isTextDelta(call)).toBe(false);
    expect(isToolCallEvent(call)).toBe(true);
    expect(isToolCallEvent(delta)).toBe(false);
  });

  it("AgentEvent union includes the permission.ask event", () => {
    const ev: AgentEvent = {
      type: "permission.ask",
      requestId: "r1",
      toolName: "shell",
      permissionLevel: "exec",
      preview: "npm test",
    };
    expect(ev.type).toBe("permission.ask");
  });
});
