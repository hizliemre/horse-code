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
/** Two tasks with nothing declared between them — the only shape the audit has anything to say about. */
function parallelBoard(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "define the Todo type", files: ["src/models/todo.ts"] });
  b.addCard({ id: "t2", title: "build the todo list view", files: ["src/ui/list.tsx"] });
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

/**
 * This role used to be asked to CONFIRM the waves — work it could not do.
 *
 * `computeWaves` already yields the widest schedule the declared dependencies allow, and `validateWaves`
 * checked the answer against those same dependencies, so the only alternative that could pass was a MORE
 * SERIAL one. The call could make the plan worse and had no path to making it better. What nothing verified
 * was the dependencies themselves, and that is a question about meaning — which is what it is asked now.
 */
describe("runTeamLead", () => {
  it("applies a dependency the breakdown missed and re-plans around it", async () => {
    const p = new MockProvider([submitTurn('{"missing":[{"task":"t2","needs":"t1","why":"needs the Todo type"}]}')]);
    const board = parallelBoard();
    const plan = await runTeamLead(opts(p), board);
    expect(plan.waves).toEqual([["t1"], ["t2"]]);
    expect(plan.added).toHaveLength(1);
    expect(board.get("t2")!.deps).toEqual(["t1"]); // the board carries it, so the wave loop blocks on it too
  });

  it("leaves the plan alone when the audit finds nothing", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"spurious":[]}')]);
    const plan = await runTeamLead(opts(p), parallelBoard());
    expect(plan.waves).toEqual([["t1", "t2"]]);
    expect(plan.added).toEqual([]);
  });

  /**
   * The two directions do not cost the same when the answer is wrong. An unnecessary dependency costs some
   * parallelism; a removed real one sends a task off before what it needs exists — it fails, and everything
   * depending on it is skipped. So this one is reported and left in place until its rate is known.
   */
  it("reports a dependency it thinks is unnecessary without removing it", async () => {
    const p = new MockProvider([submitTurn('{"spurious":[{"task":"t2","needs":"t1","why":"unrelated"}]}')]);
    const board = chainBoard();
    board.addCard({ id: "t3", title: "Z" }); // a wave with two members, or nothing is asked at all
    const plan = await runTeamLead(opts(p), board);
    expect(plan.suspected).toHaveLength(1);
    expect(board.get("t2")!.deps).toEqual(["t1"]); // still there
    expect(plan.waves).toEqual([["t1", "t3"], ["t2"]]);
  });

  /** One bad suggestion must not leave the board unschedulable — computeWaves throws on a cycle. */
  it("drops an added dependency that would close a cycle", async () => {
    const p = new MockProvider([submitTurn('{"missing":[{"task":"t1","needs":"t2","why":"backwards"}]}')]);
    const board = chainBoard();
    board.addCard({ id: "t3", title: "Z" });
    const plan = await runTeamLead(opts(p), board);
    expect(plan.added).toEqual([]);
    expect(board.get("t1")!.deps).toEqual([]);
    expect(plan.waves).toEqual([["t1", "t3"], ["t2"]]);
  });

  it("ignores a task id the audit invented", async () => {
    const p = new MockProvider([submitTurn('{"missing":[{"task":"nope","needs":"t1","why":"x"}]}')]);
    const plan = await runTeamLead(opts(p), parallelBoard());
    expect(plan.added).toEqual([]);
    expect(plan.waves).toEqual([["t1", "t2"]]);
  });

  // Nothing runs together → nothing can collide → there is no question worth paying for.
  it("does not call the model when no two tasks would run at the same time", async () => {
    const p = new MockProvider([submitTurn('{"missing":[]}')]);
    const plan = await runTeamLead(opts(p), chainBoard());
    expect(p.requests).toHaveLength(0);
    expect(plan.waves).toEqual([["t1"], ["t2"]]);
  });

  it("gives the audit the file lists and acceptance criteria, not just the titles", async () => {
    const p = new MockProvider([submitTurn('{"missing":[]}')]);
    const board = new Board();
    board.addCard({ id: "t1", title: "define the Todo type", files: ["src/models/todo.ts"],
      acceptance: ["src/models/todo.ts exports Todo"] });
    board.addCard({ id: "t2", title: "build the todo list view", files: ["src/ui/list.tsx"] });
    await runTeamLead(opts(p), board);
    const sent = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("src/models/todo.ts");
    expect(sent).toContain("exports Todo");
    expect(sent).toContain("AT THE SAME TIME");
  });

  it("keeps the plan as written when the audit produces no submit", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hmm" }, { type: "done", finishReason: "stop" }]]);
    const plan = await runTeamLead(opts(p), parallelBoard());
    expect(plan.waves).toEqual([["t1", "t2"]]);
  });

  it("does not fall back when aborted, rethrows the error", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"missing":[]}')]);
    await expect(runTeamLead({ ...opts(p), signal: ac.signal }, parallelBoard())).rejects.toThrow(/cancelled/);
  });
});
