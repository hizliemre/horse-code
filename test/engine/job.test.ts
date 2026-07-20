import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../../src/engine/job.js";
import type { JobDeps } from "../../src/engine/job.js";
import { buildCouncilRegistry } from "../../src/engine/review.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { PRAdapter } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { CouncilorConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider, ChatRequest } from "../../src/core/types.js";

// Tüm rolleri systemPrompt'a göre yanıtlayan uçtan-uca provider.
function jobProvider(opts: { intent?: string; judge?: string[] } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
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
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "spec.md", content: "# spec" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("P-planner")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "plan.md", content: "# plan" })); return; }
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
      yield* stop("ok"); // coder / senior-coder / architect / team-lead → no-op
    },
  };
}

function fakeAdapter(): PRAdapter & { calls: number } {
  const a = { calls: 0, async createPR() { a.calls++; return { url: "http://pr/1", number: 1 }; } };
  return a;
}

function jdeps(provider: Provider, manager: WorktreeManager, prAdapter: PRAdapter, signal?: AbortSignal): JobDeps {
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
        expect(existsSync(join(res.session.baseWorktree, "spec.md"))).toBe(true);
        expect(existsSync(join(res.session.baseWorktree, "plan.md"))).toBe(true);
      }
      expect(adapter.calls).toBe(1);
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
});
