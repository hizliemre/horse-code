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
    messages: [{ role: "user", content: "confirm the waves" }],
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
  it("uses the LLM's waves when valid; the request contains cards + suggestion", async () => {
    const p = new MockProvider([submitTurn('{"waves":[["t1"],["t2"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
    const sent = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("t1");
    expect(sent).toContain("Deterministically suggested waves");
  });

  it("falls back to the deterministic baseline when the LLM returns invalid waves", async () => {
    // t2 first, t1 after → t2's dep (t1) is not in an earlier wave → invalid
    const p = new MockProvider([submitTurn('{"waves":[["t2"],["t1"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]); // deterministic suggested
  });

  it("falls back to the deterministic baseline when the LLM produces no submit", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hmm" }, { type: "done", finishReason: "stop" }]]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
  });

  it("does not fall back when aborted, rethrows the error", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"waves":[["t1"],["t2"]]}')]);
    await expect(runTeamLead({ ...opts(p), signal: ac.signal }, chainBoard())).rejects.toThrow(/cancelled/);
  });
});
