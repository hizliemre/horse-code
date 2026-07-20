import { describe, it, expect } from "vitest";
import { runTeamLead } from "../../src/engine/team-lead.js";
import { Board } from "../../src/board/board.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

function chainBoard(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X" });
  b.addCard({ id: "t2", title: "Y", deps: ["t1"] });
  return b;
}
function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen team-lead'sin",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "dalgaları teyit et" }],
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

describe("runTeamLead", () => {
  it("LLM geçerli dalga döndürünce onu kullanır; istekte kartlar + öneri bulunur", async () => {
    const p = new MockProvider([submitTurn('{"waves":[["t1"],["t2"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
    const sent = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("t1");
    expect(sent).toContain("Deterministik önerilen dalgalar");
  });

  it("LLM geçersiz dalga döndürünce deterministik tabana düşer", async () => {
    // t2 önce, t1 sonra → t2'nin dep'i (t1) önceki dalgada değil → geçersiz
    const p = new MockProvider([submitTurn('{"waves":[["t2"],["t1"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]); // deterministik suggested
  });

  it("LLM submit üretmezse deterministik tabana düşer", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hmm" }, { type: "done", finishReason: "stop" }]]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
  });
});
