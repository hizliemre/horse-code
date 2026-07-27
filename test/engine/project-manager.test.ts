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

  /**
   * The task list already names each task's files; they used to stop there and never reach the board, so
   * wave planning had nothing but `deps` — an unverified account — to decide what could run in parallel.
   */
  it("carries each task's file list onto the card", async () => {
    const p = new MockProvider([
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[],"files":["src/store.ts","test/store.test.ts"]}]}'),
    ]);
    const board = await runProjectManager(opts(p));
    expect(board.get("t1")!.files).toEqual(["src/store.ts", "test/store.test.ts"]);
  });

  /** A model that omits the field must not fail the breakdown — an empty list simply means "unknown". */
  it("accepts a task that names no files", async () => {
    const p = new MockProvider([submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[]}]}')]);
    expect((await runProjectManager(opts(p))).get("t1")!.files).toEqual([]);
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
