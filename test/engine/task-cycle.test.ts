import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskCycle } from "../../src/engine/task-cycle.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

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
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: '{"path":"out.txt","content":"kod"}' } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }];

function deps(provider: MockProvider): TaskCycleDeps {
  const roles = {
    router: { models: ["m"], systemPrompt: "route" },
    coder: { models: ["m"], systemPrompt: "coder" },
    "code-reviewer": { models: ["m"], systemPrompt: "reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X yap" });
  return b;
}

describe("runTaskCycle", () => {
  it("pass: implement → review → DONE, dosya yazılı, worktree + stage kaydı", async () => {
    // router(coder) → implementer(write, done) → reviewer(pass)
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    expect(c.column).toBe("DONE");
    expect(c.worktree).toBe(dir);
    expect(c.stageHistory.some((s) => s.action === "reviewed:pass")).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("kod");
  });

  it("fail: TODO'ya döner, reviewNotes = notlar, reviewed:fail stage'i", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["testsiz"]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.reviewNotes).toEqual(["testsiz"]);
    expect(c.stageHistory.some((s) => s.action === "reviewed:fail")).toBe(true);
  });

  it("bilinmeyen task → hata", async () => {
    const p = new MockProvider([]);
    await expect(runTaskCycle(deps(p), boardWithTask(), "yok", dir)).rejects.toThrow(/bilinmeyen task/);
  });

  it("fail: notes boşsa bile dönüş sinyali korunur (varsayılan not eklenir)", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":[]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.reviewNotes.length).toBeGreaterThan(0);
  });

  it("pass: önceki fail'den kalan reviewNotes DONE'da temizlenir", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}')]);
    const board = boardWithTask();
    board.addReviewNote("t1", "eski");
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.reviewNotes).toEqual([]);
  });
});
