import { describe, it, expect } from "vitest";
import { runProjectManager } from "../../src/engine/project-manager.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "you are the project-manager",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "plan: do X and Y" }],
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

describe("runProjectManager", () => {
  it("converts tasks into Board cards", async () => {
    const p = new MockProvider([
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[]},{"id":"t2","title":"Y","deps":["t1"]}]}'),
    ]);
    const board = await runProjectManager(opts(p));
    expect(board.list().map((c) => ({ id: c.id, title: c.title, deps: c.deps, column: c.column }))).toEqual([
      { id: "t1", title: "X", deps: [], column: "TODO" },
      { id: "t2", title: "Y", deps: ["t1"], column: "TODO" },
    ]);
  });

  it("dangling dep → self-correct (superRefine isError → resubmit)", async () => {
    const p = new MockProvider([
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":["missing"]}]}'), // invalid
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[]}]}'), // corrected
    ]);
    const board = await runProjectManager(opts(p));
    expect(board.list().map((c) => c.id)).toEqual(["t1"]);
    expect(p.requests).toHaveLength(2);
  });
});
