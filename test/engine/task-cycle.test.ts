import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskCycle, runCycleWithRole } from "../../src/engine/task-cycle.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";
import { reviewBodies, codeReviewPass, codeReviewFail } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-cycle-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function writeTurn(): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: '{"path":"out.txt","content":"code"}' } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }];

function deps(provider: MockProvider): ReviewDeps {
  const roles = {
    router: { models: ["m"], systemPrompt: "route" },
    coder: { models: ["m"], systemPrompt: "coder" },
    "senior-coder": { models: ["m"], systemPrompt: "senior-coder" },
    "code-reviewer": { models: ["m"], systemPrompt: "reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "do X" });
  return b;
}

describe("runTaskCycle", () => {
  it("pass: implement → review → DONE, file written, worktree + stage recorded", async () => {
    // router(coder) → implementer(write, done) → reviewer(pass)
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, ...codeReviewPass()]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    expect(c.column).toBe("DONE");
    expect(c.worktree).toBe(dir);
    expect(c.stageHistory.some((s) => s.action === "reviewed:pass")).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("code");
  });

  it("fail: goes back to TODO, reviewNotes = notes, reviewed:fail stage", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, ...codeReviewFail("no tests")]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.reviewNotes).toEqual(["[critical] code-correctness: no tests"]); // lens + severity prefixed
    expect(c.stageHistory.some((s) => s.action === "reviewed:fail")).toBe(true);
  });

  it("a cancelled review stays in REVIEW and requires a human note before retry", async () => {
    const controller = new AbortController();
    class CancellingProvider extends MockProvider {
      override async *chat(req: Parameters<MockProvider["chat"]>[0], signal: AbortSignal) {
        if (this.requests.length >= 3) {
          controller.abort(new Error("cancelled"));
          throw new Error("cancelled");
        }
        yield* super.chat(req, signal);
      }
    }
    const d = deps(new CancellingProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn]));
    d.signal = controller.signal;
    const board = boardWithTask();

    const v = await runTaskCycle(d, board, "t1", dir);
    expect(v.verdict).toBe("fail");

    const c = board.get("t1")!;
    expect(c.column).toBe("REVIEW");
    expect(c.stageHistory.some((s) => s.action === "reviewed:cancelled")).toBe(true);
    expect(c.stageHistory.some((s) => s.action === "reviewed:fail")).toBe(false);
    expect(c.reviewNotes).toEqual(["Review was cancelled. Add a human note before retrying this task."]);
    expect(c.attempts).toBe(0);
  });

  it("unknown task → error", async () => {
    const p = new MockProvider([]);
    await expect(runTaskCycle(deps(p), boardWithTask(), "missing", dir)).rejects.toThrow(/unknown task/);
  });

  it("fail: return signal preserved even with empty notes (a default note is added)", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":[]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.reviewNotes.length).toBeGreaterThan(0);
  });

  it("pass: leftover reviewNotes from a previous fail are cleared on DONE", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, ...codeReviewPass()]);
    const board = boardWithTask();
    board.addReviewNote("t1", "old");
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.reviewNotes).toEqual([]);
  });

  it("runCycleWithRole: runs with an explicit senior-coder role (no routing), pass→DONE", async () => {
    // NO routing turn; the first turn goes straight to the implementer
    const p = new MockProvider([writeTurn(), doneTurn, ...codeReviewPass()]);
    const board = boardWithTask();
    const v = await runCycleWithRole(deps(p), board, "t1", dir, "senior-coder");
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    // implementer ran with the senior-coder system prompt
    expect(p.requests[0].messages[0].content).toContain("senior-coder");
  });
});

describe("acceptance gate blocks a review-passing task that did not do the work", () => {
  it("criteria unmet → back to TODO with them as notes, NOT done", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "add the Todo model", acceptance: ["src/models/todo.ts exports a Todo type"] });
    // router → coder writes → code review passes → the GATE reports the criterion unmet
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      writeTurn(), doneTurn,
      ...codeReviewPass(),
      submit(JSON.stringify({ checks: [{ criterion: "src/models/todo.ts exports a Todo type", met: false, evidence: "no such file" }] })),
    ]);
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.stageHistory.some((s) => s.action === "acceptance:failed")).toBe(true);
    expect(c.stageHistory.some((s) => s.action === "reviewed:pass")).toBe(false); // never marked done
    expect(c.reviewNotes[0]).toMatch(/Acceptance criterion not met/);
  });

  it("criteria met → the task completes as before", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "add the Todo model", acceptance: ["src/models/todo.ts exports a Todo type"] });
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      writeTurn(), doneTurn,
      ...codeReviewPass(),
      submit(JSON.stringify({ checks: [{ criterion: "src/models/todo.ts exports a Todo type", met: true, evidence: "found the export" }] })),
    ]);
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.stageHistory.some((s) => s.action === "acceptance:passed")).toBe(true);
  });
});
