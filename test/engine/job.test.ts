import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../../src/engine/job.js";
import type { JobDeps } from "../../src/engine/job.js";
import { buildCouncilRegistry } from "../../src/engine/review.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { RevisionPRAdapter } from "../../src/adapters/pr.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { CouncilorConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider, ChatRequest } from "../../src/core/types.js";
import type { ProgressEvent } from "../../src/engine/progress.js";

// Tüm rolleri systemPrompt'a göre yanıtlayan uçtan-uca provider.
function jobProvider(opts: { intent?: string; judge?: string[]; principal?: string[] } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  let principalCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const userContent = req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const writeTarget = (userContent.match(/"([^"]+\.md)" with write_file/) ?? userContent.match(/"([^"]+\.md)"/))?.[1] ?? "spec.md";
      const submit = function* (a: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const call = function* (name: string, a: string) {
        yield { type: "tool-call", toolCall: { id: "t", name, arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const stop = function* (t: string) {
        yield { type: "text-delta", text: t } as const;
        yield { type: "done", finishReason: "stop" } as const;
      };
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"X yap","intent":"${opts.intent ?? "feature"}"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach raporu"); return; }
      if (sys.includes("P-analyst")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: writeTarget, content: "# spec" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("P-planner")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: writeTarget, content: "# plan" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("P-pm")) { yield* submit('{"tasks":[{"id":"t1","title":"gorev-a","deps":[]}]}'); return; }
      if (sys.includes("P-router")) { yield* submit('{"role":"coder"}'); return; }
      if (sys.includes("P-reviewer")) { yield* submit('{"verdict":"pass","notes":[]}'); return; }
      if (sys.includes("Perspektif")) { yield* submit('{"concerns":[],"recommendation":"approve"}'); return; }
      if (sys.includes("P-judge")) {
        const arr = opts.judge ?? ['{"decision":"pass","feedback":[],"question":""}'];
        yield* submit(arr[judgeCall] ?? arr[arr.length - 1]);
        judgeCall++;
        return;
      }
      if (sys.includes("P-principal")) {
        if (convo.includes("FINAL DECISION")) { yield* submit('{"decision":"accept","question":""}'); return; }
        const arr = opts.principal ?? ['{"decision":"approve","comments":[]}'];
        yield* submit(arr[principalCall] ?? arr[arr.length - 1]);
        principalCall++;
        return;
      }
      if (sys.includes("P-senior-coder")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "fix.txt", content: "düzeltme" })); return; }
        yield* stop("bitti"); return;
      }
      yield* stop("ok"); // coder / architect / team-lead → no-op
    },
  };
}

function fakeAdapter(): RevisionPRAdapter & { calls: number; comments: string[][] } {
  const a = {
    calls: 0,
    comments: [] as string[][],
    async createPR() { a.calls++; return { url: "http://pr/1", number: 1 }; },
    async postComments(c: string[]) { a.comments.push(c); },
  };
  return a;
}

function jdeps(provider: Provider, manager: WorktreeManager, prAdapter: RevisionPRAdapter, signal?: AbortSignal): JobDeps {
  const roles: Record<string, RoleConfig> = {
    refiner: { models: ["m"], systemPrompt: "P-refiner" },
    coach: { models: ["m"], systemPrompt: "P-coach" },
    analyst: { models: ["m"], systemPrompt: "P-analyst" },
    planner: { models: ["m"], systemPrompt: "P-planner" },
    "project-manager": { models: ["m"], systemPrompt: "P-pm" },
    judge: { models: ["m"], systemPrompt: "P-judge" },
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "principal-coder": { models: ["m"], systemPrompt: "P-principal" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
    "team-lead": { models: ["m"], systemPrompt: "P-teamlead" },
  };
  const councilors: CouncilorConfig[] = [{ name: "sec", perspective: "güvenlik", models: ["m"] }];
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    councilRegistry: buildCouncilRegistry(councilors),
    councilors,
    manager,
    prAdapter,
    rounds: 1,
    askHuman: async () => ({ action: "abandon" }),
  };
}

describe("runJob", () => {
  it("chat: intent chat → coach cevabı", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "chat" });
      const res = await runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "merhaba", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2 });
      expect(res.kind).toBe("chat");
      if (res.kind === "chat") expect(res.response).toBe("coach raporu");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("rejected: spec onaylanmaz → rejected(spec)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "feature", judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
      const res = await runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "durdur", maxRounds: 1 });
      expect(res.kind).toBe("rejected");
      if (res.kind === "rejected") expect(res.stage).toBe("spec");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("done: uçtan uca feature → spec/plan → board → waves → PR → rapor", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const adapter = fakeAdapter();
      const p = jobProvider({ intent: "feature" });
      const res = await runJob(jdeps(p, mgr, adapter), { prompt: "X ekle", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2 });
      expect(res.kind).toBe("done");
      if (res.kind === "done") {
        expect(res.wave.status).toBe("completed");
        expect(res.report).toBe("coach raporu");
        expect(existsSync(join(res.session.baseWorktree, ".hc/spec.md"))).toBe(true);
        expect(existsSync(join(res.session.baseWorktree, ".hc/plan.md"))).toBe(true);
        expect(res.revision?.status).toBe("approved"); // principal ilk turda onayladı
      }
      expect(adapter.calls).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("done: principal değişiklik ister → revision (senior düzeltir, postComments)", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const adapter = fakeAdapter();
      // principal: round1 request-changes, round2 approve
      const p = jobProvider({ intent: "feature", principal: ['{"decision":"request-changes","comments":["testsiz"]}', '{"decision":"approve","comments":[]}'] });
      const res = await runJob(jdeps(p, mgr, adapter), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, revisionRounds: 3 });
      expect(res.kind).toBe("done");
      if (res.kind === "done") expect(res.revision?.status).toBe("approved");
      expect(adapter.comments).toEqual([["testsiz"]]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("abort: pre-aborted → fırlatır", async () => {
    const repo = await initTmpRepo();
    try {
      const ac = new AbortController(); ac.abort();
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "feature" });
      await expect(
        runJob(jdeps(p, mgr, fakeAdapter(), ac.signal), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2 }),
      ).rejects.toThrow();
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("done: onEvent faz sırası + board event'leri", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const adapter = fakeAdapter();
      const p = jobProvider({ intent: "feature" });
      const events: ProgressEvent[] = [];
      const res = await runJob(jdeps(p, mgr, adapter), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, onEvent: (e) => events.push(e) });
      expect(res.kind).toBe("done");
      const phases = events.filter((e) => e.kind === "phase").map((e) => (e as { phase: string }).phase);
      expect(phases).toEqual(["upstream", "approved", "board", "waves", "waves-done", "pr", "revision", "revision-done", "report", "done"]);
      expect(events.some((e) => e.kind === "board")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("chat: onEvent [upstream, chat]", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "chat" });
      const events: ProgressEvent[] = [];
      await runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "merhaba", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, onEvent: (e) => events.push(e) });
      expect(events.filter((e) => e.kind === "phase").map((e) => (e as { phase: string }).phase)).toEqual(["upstream", "chat"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("onEvent throw ederse job düşmez (gözlemci izole)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "chat" });
      const res = await runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "x", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, onEvent: () => { throw new Error("render patladı"); } });
      expect(res.kind).toBe("chat");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("beklenmedik throw'da session temizlenir (orphan worktree yok)", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      let closed = false;
      const origClose = mgr.closeSession.bind(mgr);
      mgr.closeSession = async (s) => { closed = true; return origClose(s); };
      mgr.commitMerge = async () => { throw new Error("patla"); }; // approved sonrası erken throw
      const p = jobProvider({ intent: "feature" });
      await expect(
        runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2 }),
      ).rejects.toThrow("patla");
      expect(closed).toBe(true); // catch closeSession'ı çağırdı
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});
