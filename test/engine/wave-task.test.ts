import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWaveTask } from "../../src/engine/wave-task.js";
import type { WaveTaskManager, WaveTaskDeps } from "../../src/engine/wave-task.js";
import type { AskHuman } from "../../src/engine/escalation.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function writeTurn(path: string, content: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }];

interface WOpts { rounds?: number; askHuman?: AskHuman; serialize?: <T>(fn: () => Promise<T>) => Promise<T>; signal?: AbortSignal; resolveConflict?: WaveTaskDeps["resolveConflict"] }
function wdeps(provider: MockProvider, manager: WaveTaskManager, opts: WOpts = {}): WaveTaskDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    rounds: opts.rounds ?? 3,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
    manager,
    serialize: opts.serialize,
    resolveConflict: opts.resolveConflict,
  };
}
function board1(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X yap" });
  return b;
}
// Stub manager: gerçek yazılabilir worktree + no-op commit + verilen merge sonucu
function stubManager(worktree: string, merge: () => Promise<{ status: "merged" } | { status: "conflict"; files: string[] }>): WaveTaskManager {
  return {
    deriveTask: async () => ({ taskSlug: "t", worktree, branch: "b" }),
    commitTask: async () => {},
    mergeTask: merge,
  };
}

describe("runWaveTask", () => {
  it("merged: derive → escalate(pass) → commit → merge; base worktree dosyayı alır, kart DONE", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "kod"), doneTurn,
        submit('{"verdict":"pass","notes":[]}'),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, mgr), session, board, "t1");
      expect(res.status).toBe("merged");
      expect(board.get("t1")!.column).toBe("DONE");
      expect(await readFile(join(session.baseWorktree, "out.txt"), "utf8")).toBe("kod");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("task-failed: escalation abandon → merge YOK, base değişmez", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "yarim"), doneTurn, submit('{"verdict":"fail","notes":["a"]}'),
        writeTurn("out.txt", "yarim2"), doneTurn, submit('{"verdict":"fail","notes":["b"]}'),
        submit('{"rootCause":"x","plan":["p"]}'), writeTurn("out.txt", "yarim3"), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, mgr, { rounds: 1 }), session, board, "t1"); // askHuman default abandon
      expect(res.status).toBe("task-failed");
      expect(existsSync(join(session.baseWorktree, "out.txt"))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("conflict: mergeTask conflict → {status:'conflict', files} relay + merge-conflict stage'i", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "kod"), doneTurn,
        submit('{"verdict":"pass","notes":[]}'),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, stub), {} as WorktreeSession, board, "t1");
      expect(res.status).toBe("conflict");
      if (res.status === "conflict") expect(res.files).toEqual(["shared.txt"]);
      expect(board.get("t1")!.stageHistory.some((s) => s.action === "merge-conflict")).toBe(true);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("resolveConflict {merged} → runWaveTask merged döner", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      let called = 0;
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const resolveConflict = async () => { called++; return { status: "merged" as const }; };
      const p = new MockProvider([
        submit('{"role":"coder"}'), writeTurn("out.txt", "kod"), doneTurn, submit('{"verdict":"pass","notes":[]}'),
      ]);
      const res = await runWaveTask(wdeps(p, stub, { resolveConflict }), {} as WorktreeSession, board1(), "t1");
      expect(called).toBe(1);
      expect(res.status).toBe("merged");
    } finally { await rm(wt, { recursive: true, force: true }); }
  });

  it("resolveConflict {conflict} → runWaveTask conflict döner", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const resolveConflict = async () => ({ status: "conflict" as const, files: ["shared.txt"] });
      const p = new MockProvider([
        submit('{"role":"coder"}'), writeTurn("out.txt", "kod"), doneTurn, submit('{"verdict":"pass","notes":[]}'),
      ]);
      const res = await runWaveTask(wdeps(p, stub, { resolveConflict }), {} as WorktreeSession, board1(), "t1");
      expect(res.status).toBe("conflict");
    } finally { await rm(wt, { recursive: true, force: true }); }
  });

  it("rounds clamp: rounds=0 → tier0 coder koşar (konseye düşmez)", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "merged" }));
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "kod"), doneTurn,
        submit('{"verdict":"pass","notes":[]}'),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, stub, { rounds: 0 }), {} as WorktreeSession, board, "t1");
      expect(res.status).toBe("merged");
      const sys = p.requests.map((r) => r.messages[0].content);
      expect(sys).toContain("P-coder");
      expect(sys).not.toContain("P-architect");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("abort: pre-aborted signal → rejects (yutulmaz)", async () => {
    const ac = new AbortController();
    ac.abort();
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "merged" }));
      const p = new MockProvider([submit('{"role":"coder"}')]);
      await expect(
        runWaveTask(wdeps(p, stub, { signal: ac.signal }), {} as WorktreeSession, board1(), "t1"),
      ).rejects.toThrow();
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("bilinmeyen task → hata", async () => {
    const stub = stubManager("/x", async () => ({ status: "merged" }));
    await expect(
      runWaveTask(wdeps(new MockProvider([]), stub), {} as WorktreeSession, new Board(), "yok"),
    ).rejects.toThrow(/bilinmeyen task/);
  });
});
