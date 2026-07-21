import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutex, runWave, runWaveEngine, runWaves } from "../../src/engine/wave-engine.js";
import type { WaveEngineDeps } from "../../src/engine/wave-engine.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { AskHuman } from "../../src/engine/escalation.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession, PRAdapter } from "../../src/worktree/manager.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";

// Content-based deterministic provider: responds based on the system prompt (role) + the task title in the message.
function engineProvider(failTasks: string[] = []): Provider {
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const emitSubmit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      if (sys.includes("P-router")) { yield* emitSubmit('{"role":"coder"}'); return; }
      if (sys.includes("P-architect")) { yield* emitSubmit('{"rootCause":"x","plan":["y"]}'); return; }
      if (sys.includes("P-reviewer")) {
        const fail = failTasks.some((t) => convo.includes(t));
        yield* emitSubmit(fail ? '{"verdict":"fail","notes":["nope"]}' : '{"verdict":"pass","notes":[]}');
        return;
      }
      // coder / senior / team-lead / other → no-op (no submit)
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

function fakeAdapter(): PRAdapter & { calls: number } {
  const a = { calls: 0, async createPR() { a.calls++; return { url: "http://pr/1", number: 1 }; } };
  return a;
}

interface EOpts { failTasks?: string[]; askHuman?: AskHuman; signal?: AbortSignal; rounds?: number }
function edeps(mgr: WorktreeManager, prAdapter: PRAdapter, opts: EOpts = {}): WaveEngineDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
    "team-lead": { models: ["m"], systemPrompt: "P-teamlead" },
  };
  return {
    provider: engineProvider(opts.failTasks),
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    rounds: opts.rounds ?? 1,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
    manager: mgr,
    prAdapter,
  };
}

describe("createMutex", () => {
  it("concurrent calls run sequentially (no overlap)", async () => {
    const ser = createMutex();
    const order: string[] = [];
    const mk = (id: string, ms: number) => ser(async () => {
      order.push(`${id}-start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${id}-end`);
      return id;
    });
    const [a, b] = await Promise.all([mk("a", 20), mk("b", 5)]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("runWave", () => {
  it("all-pass (parallel): both tasks merged", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b" });
      const o = await runWave(edeps(mgr, fakeAdapter()), session, board, ["t1", "t2"], new Set());
      expect(o.merged.sort()).toEqual(["t1", "t2"]);
      expect(o.failed).toEqual([]);
      expect(o.skipped).toEqual([]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("one-fail: failing task is failed, the other is merged", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b" });
      const o = await runWave(edeps(mgr, fakeAdapter(), { failTasks: ["task-a"] }), session, board, ["t1", "t2"], new Set());
      expect(o.failed).toEqual(["t1"]);
      expect(o.merged).toEqual(["t2"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("skip: blocked dependency → task is skipped (doesn't run)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t3", title: "task-c", deps: ["t1"] });
      const o = await runWave(edeps(mgr, fakeAdapter()), session, board, ["t3"], new Set(["t1"]));
      expect(o.skipped).toEqual(["t3"]);
      expect(o.merged).toEqual([]);
      expect(board.get("t3")!.stageHistory.some((s) => s.action === "skipped")).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

describe("runWaves", () => {
  it("runs with an injected session (doesn't call openSession), all-pass → completed + PR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const adapter = fakeAdapter();
      const res = await runWaves(edeps(mgr, adapter), session, board, { base: "main" });
      expect(res.status).toBe("completed");
      expect(adapter.calls).toBe(1);
      expect(res.session).toBe(session); // the same session was used
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("runWaveEngine", () => {
  it("completed: all pass → push + openPR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("completed");
      expect(adapter.calls).toBe(1);
      if (res.status === "completed") expect(res.pr.url).toBe("http://pr/1");
      expect(res.waves).toEqual([["t1"], ["t2"]]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("partial: t1 fails → t2(dep t1) skipped → no PR opened", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter, { failTasks: ["task-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(adapter.calls).toBe(0);
      if (res.status === "partial") {
        expect(res.failed).toEqual(["t1"]);
        expect(res.skipped).toEqual(["t2"]);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("partial: transitive skip (t1 fail → t2 skip → t3 skip)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      board.addCard({ id: "t3", title: "task-c", deps: ["t2"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter, { failTasks: ["task-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(adapter.calls).toBe(0);
      if (res.status === "partial") {
        expect(res.failed).toEqual(["t1"]);
        expect(res.skipped.sort()).toEqual(["t2", "t3"]);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("abort: pre-aborted signal → rethrows", async () => {
    const repo = await initTmpRepo();
    try {
      const ac = new AbortController();
      ac.abort();
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      await expect(
        runWaveEngine(edeps(mgr, fakeAdapter(), { signal: ac.signal }), board, { fromBranch: "main", jobName: "job" }),
      ).rejects.toThrow();
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
