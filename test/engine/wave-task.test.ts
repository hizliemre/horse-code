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
import { reviewBodies, codeReviewPass, codeReviewFail } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

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
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }];

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
    specKit: fakeSpecKit,
    ...reviewBodies(),
    rounds: opts.rounds ?? 3,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
    manager,
    serialize: opts.serialize,
    resolveConflict: opts.resolveConflict,
  };
}
function board1(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "do X" });
  return b;
}
// Stub manager: a real writable worktree + no-op commit + a given merge result
function stubManager(worktree: string, merge: () => Promise<{ status: "merged" } | { status: "conflict"; files: string[] }>): WaveTaskManager {
  return {
    deriveTask: async () => ({ taskSlug: "t", worktree, branch: "b" }),
    commitTask: async () => {},
    mergeTask: merge,
  };
}

describe("runWaveTask", () => {
  it("merged: derive → escalate(pass) → commit → merge; base worktree gets the file, card DONE", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "code"), doneTurn,
        ...codeReviewPass(),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, mgr), session, board, "t1");
      expect(res.status).toBe("merged");
      expect(board.get("t1")!.column).toBe("DONE");
      expect(await readFile(join(session.baseWorktree, "out.txt"), "utf8")).toBe("code");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("task-failed: escalation abandon → NO merge, base unchanged", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "half"), doneTurn, ...codeReviewFail("a"),
        writeTurn("out.txt", "half2"), doneTurn, ...codeReviewFail("b"),
        submit('{"rootCause":"x","plan":["p"]}'), writeTurn("out.txt", "half3"), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, mgr, { rounds: 1 }), session, board, "t1"); // askHuman default abandon
      expect(res.status).toBe("task-failed");
      expect(existsSync(join(session.baseWorktree, "out.txt"))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a genuine abort during the implementer still propagates (not swallowed as task-failed)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const ac = new AbortController();
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        [{ type: "error", message: "cancelled" }],
      ]);
      ac.abort(); // signal already aborted → the catch must rethrow, not return task-failed
      await expect(runWaveTask(wdeps(p, mgr, { signal: ac.signal }), session, board1(), "t1")).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("conflict: mergeTask conflict → {status:'conflict', files} relayed + merge-conflict stage", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "code"), doneTurn,
        ...codeReviewPass(),
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

  it("resolveConflict {merged} → runWaveTask returns merged", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      let called = 0;
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const resolveConflict = async () => { called++; return { status: "merged" as const }; };
      const p = new MockProvider([
        submit('{"role":"coder"}'), writeTurn("out.txt", "code"), doneTurn, ...codeReviewPass(),
      ]);
      const res = await runWaveTask(wdeps(p, stub, { resolveConflict }), {} as WorktreeSession, board1(), "t1");
      expect(called).toBe(1);
      expect(res.status).toBe("merged");
    } finally { await rm(wt, { recursive: true, force: true }); }
  });

  it("resolveConflict {conflict} → runWaveTask returns conflict", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "conflict", files: ["shared.txt"] }));
      const resolveConflict = async () => ({ status: "conflict" as const, files: ["shared.txt"] });
      const p = new MockProvider([
        submit('{"role":"coder"}'), writeTurn("out.txt", "code"), doneTurn, ...codeReviewPass(),
      ]);
      const res = await runWaveTask(wdeps(p, stub, { resolveConflict }), {} as WorktreeSession, board1(), "t1");
      expect(res.status).toBe("conflict");
    } finally { await rm(wt, { recursive: true, force: true }); }
  });

  it("rounds clamp: rounds=0 → tier0 coder runs (doesn't escalate to council)", async () => {
    const wt = await mkdtemp(join(tmpdir(), "hc-stub-"));
    try {
      const stub = stubManager(wt, async () => ({ status: "merged" }));
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        writeTurn("out.txt", "code"), doneTurn,
        ...codeReviewPass(),
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, stub, { rounds: 0 }), {} as WorktreeSession, board, "t1");
      expect(res.status).toBe("merged");
      const sys = p.requests.map((r) => r.messages[0].content);
      expect(sys.some((x) => x.includes("P-coder"))).toBe(true);
      expect(sys.some((x) => x.includes("P-architect"))).toBe(false);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("abort: pre-aborted signal → rejects (not swallowed)", async () => {
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

  it("unknown task → error", async () => {
    const stub = stubManager("/x", async () => ({ status: "merged" }));
    await expect(
      runWaveTask(wdeps(new MockProvider([]), stub), {} as WorktreeSession, new Board(), "missing"),
    ).rejects.toThrow(/unknown task/);
  });
});

describe("an implementer that writes nothing", () => {
  it("is NOT reviewed or merged — the task must not be marked done having done nothing", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      // The coder answers in prose and never writes a file, on every attempt.
      const p = new MockProvider([
        submit('{"role":"coder"}'),
        doneTurn, doneTurn, doneTurn, doneTurn, doneTurn, doneTurn, doneTurn, doneTurn,
      ]);
      const board = board1();
      const res = await runWaveTask(wdeps(p, mgr, { rounds: 1 }), session, board, "t1");
      expect(res.status).toBe("task-failed");            // never silently "merged"
      const stages = board.get("t1")!.stageHistory;
      expect(stages.some((s) => s.action === "no-changes")).toBe(true);
      expect(stages.some((s) => s.action === "merged")).toBe(false);
      // …and no code review was ever run on the empty worktree.
      const sys = p.requests.map((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : ""));
      expect(sys.some((x) => x.includes("review TEAM member"))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
