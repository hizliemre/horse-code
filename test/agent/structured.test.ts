import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runStructuredRole } from "../../src/agent/structured.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

const schema = z.object({ decision: z.enum(["pass", "fail"]) });

function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen bir reviewer'sın",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "incele" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };
}

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("runStructuredRole", () => {
  it("geçerli submit'i parse edip döner; istekte submit tool'u bulunur", async () => {
    const p = new MockProvider([submitTurn('{"decision":"pass"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "pass" });
    expect(p.requests[0].tools.map((t) => t.name)).toContain("submit");
    expect(p.requests).toHaveLength(1); // geçerli submit → erken çıkış, fazladan turn yok
  });

  it("geçersiz submit sonrası geçerli submit → doğru sonuç (2 istek)", async () => {
    const p = new MockProvider([submitTurn('{"decision":"bogus"}'), submitTurn('{"decision":"fail"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "fail" });
    expect(p.requests).toHaveLength(2);
  });

  it("submit çağrılmazsa hata verir", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow(/submit çağrılmadı/);
  });

  it("provider error → hata verir", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow("boom");
  });
});
