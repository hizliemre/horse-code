# Dilim H1 — runJob Orkestratörü (Headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parçaları tek session'da birleştiren `runJob`'u kurmak: openSession → runUpstream → commit spec/plan → runProjectManager (board) → runWaves → coach raporu. + write/edit workdir-guard.

**Architecture:** `runWaves`, E4c `runWaveEngine`'inden session-almayan çekirdek olarak ayrılır (geriye dönük uyumlu). `src/engine/job.ts` F+E2+E4'ü birleştirir. `write`/`edit` tool'larına cwd-sınır guard'ı eklenir.

**Tech Stack:** TypeScript ESM, vitest, içerik-tabanlı deterministik provider + gerçek tmp git (+ bare remote) + fake PRAdapter.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; içerik-tabanlı provider (tüm roller systemPrompt'a göre keyed); gerçek fs+git + bare remote + fake PRAdapter.
- **Abort yutulmaz:** `runJob`/`runWaves` alt katman throw'unu propagate eder.
- **Birleşik session:** upstream `session.baseWorktree`'de koşar; spec/plan `commitMerge` ile baseBranch'e; done→session açık, chat/rejected→closeSession.
- **workdir-guard:** write/edit `resolve(ctx.cwd, path)` cwd dışına çıkarsa `isError`.
- **Geriye dönük uyum:** `runWaveEngine` imzası/E4c testleri değişmez (runWaves'e delege).

---

### Task 1: write/edit workdir-guard

**Files:**
- Modify: `src/tools/write.ts`, `src/tools/edit.ts`
- Test: `test/tools/write.test.ts`, `test/tools/edit.test.ts`

**Interfaces:**
- Produces: write_file/edit_file, `resolve(ctx.cwd, path)` cwd sınırının dışındaysa yazma yapmadan `{isError:true}` döner.

- [ ] **Step 1: Kırmızı test**

`test/tools/write.test.ts`'e ekle (mevcut import'lara `mkdtemp`/`rm` gerekiyorsa ekle):

```typescript
  it("cwd dışına yazma reddedilir (workdir-guard)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-wg-"));
    try {
      const res = await writeFileTool.run({ path: "../escape.txt", content: "x" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(true);
      expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("cwd içine yazılır (guard engellemez)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-wg-"));
    try {
      const res = await writeFileTool.run({ path: "alt/ic.txt", content: "y" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(false);
      expect(existsSync(join(dir, "alt", "ic.txt"))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
```

(Gerekli import'lar: `import { mkdtemp, rm } from "node:fs/promises"; import { existsSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";` — dosyada yoksa ekle.)

`test/tools/edit.test.ts`'e ekle:

```typescript
  it("cwd dışına edit reddedilir (workdir-guard)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-eg-"));
    try {
      const res = await editFileTool.run({ path: "../escape.txt", oldString: "a", newString: "b" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/tools/write.test.ts test/tools/edit.test.ts`
Expected: FAIL — guard yok (`../escape.txt` yazılıyor / isError değil).

- [ ] **Step 3: Guard'ı ekle**

`src/tools/write.ts` — `import { dirname, resolve } from "node:path";` satırını `import { dirname, resolve, sep } from "node:path";` yap. `const target = resolve(ctx.cwd, a.path);` satırından SONRA ekle:

```typescript
      const cwdResolved = resolve(ctx.cwd);
      if (target !== cwdResolved && !target.startsWith(cwdResolved + sep)) {
        return { content: `write_file: yol cwd dışında: ${a.path}`, isError: true };
      }
```

`src/tools/edit.ts` — `import { resolve } from "node:path";` → `import { resolve, sep } from "node:path";`. `const target = resolve(ctx.cwd, a.path);` satırından SONRA ekle:

```typescript
    const cwdResolved = resolve(ctx.cwd);
    if (target !== cwdResolved && !target.startsWith(cwdResolved + sep)) {
      return { content: `edit_file: yol cwd dışında: ${a.path}`, isError: true };
    }
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/tools/write.test.ts test/tools/edit.test.ts`
Expected: PASS (mevcut + yeni testler).

- [ ] **Step 5: Typecheck + tüm suite (regresyon)**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil (mevcut cwd-içi yazmalar bozulmadı), typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/tools/write.ts src/tools/edit.ts test/tools/write.test.ts test/tools/edit.test.ts
git commit -m "feat: write/edit workdir-guard (cwd dışına yazma reddedilir)"
```

---

### Task 2: `runWaves` extract (wave-engine refactor)

**Files:**
- Modify: `src/engine/wave-engine.ts`
- Test: `test/engine/wave-engine.test.ts`

**Interfaces:**
- Produces: `runWaves(deps: WaveEngineDeps, session: WorktreeSession, board: Board, opts: { base: string; prTitle?: string }): Promise<WaveEngineResult>` (openSession YOK); `runWaveEngine` aynı imzayla `runWaves`'e delege eder.

- [ ] **Step 1: Kırmızı test**

`test/engine/wave-engine.test.ts`'e ekle (`runWaves`'i üstteki `from "../../src/engine/wave-engine.js"` import'una ekle; `WorktreeSession` import'u gerekiyorsa zaten var):

```typescript
describe("runWaves", () => {
  it("enjekte session'la koşar (openSession açmaz), all-pass → completed + PR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      const adapter = fakeAdapter();
      const res = await runWaves(edeps(mgr, adapter), session, board, { base: "main" });
      expect(res.status).toBe("completed");
      expect(adapter.calls).toBe(1);
      expect(res.session).toBe(session); // aynı session kullanıldı
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: FAIL — `runWaves` export yok.

- [ ] **Step 3: runWaves extract + runWaveEngine delege**

`src/engine/wave-engine.ts` — mevcut `runWaveEngine`'i (aşağıdaki `export async function runWaveEngine ...` bloğunu) şununla değiştir:

```typescript
/** Bir session'da dalgaları yürütür (openSession YOK): team-lead → dalgalar → push+openPR / {partial}. */
export async function runWaves(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  opts: { base: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const waves = await runTeamLead(teamLeadOpts(deps, session), board);

  const blocked = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wave of waves) {
    const o = await runWave(deps, session, board, wave, blocked);
    for (const t of o.failed) { blocked.add(t); failed.push(t); }
    for (const t of o.skipped) { blocked.add(t); skipped.push(t); }
  }

  if (failed.length === 0 && skipped.length === 0) {
    await deps.manager.push(session);
    const body = "Tamamlanan task'lar:\n" + board.list().map((c) => `- ${c.title}`).join("\n");
    const pr = await deps.manager.openPR(session, deps.prAdapter, {
      base: opts.base,
      title: opts.prTitle ?? `hc: ${session.jobSlug}`,
      body,
    });
    return { status: "completed", session, pr, waves };
  }
  return { status: "partial", session, failed, skipped, waves };
}

/** Deterministik dış döngü: openSession → runWaves (geriye dönük uyumlu sarmalayıcı). */
export async function runWaveEngine(
  deps: WaveEngineDeps,
  board: Board,
  opts: { fromBranch: string; jobName: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  return runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
}
```

`WorktreeSession` tipi import'ta yoksa ekle (`import type { ..., WorktreeSession } from "../worktree/manager.js";`).

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: PASS (yeni runWaves testi + mevcut tüm runWaveEngine/runWave/createMutex testleri — delege geriye dönük uyumlu).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/wave-engine.ts test/engine/wave-engine.test.ts
git commit -m "refactor: runWaves extract (session parametreli); runWaveEngine delege eder"
```

---

### Task 3: `runJob` + `runCoachReport`

**Files:**
- Create: `src/engine/job.ts`
- Test: `test/engine/job.test.ts`

**Interfaces:**
- Consumes: F `runUpstream`; E2 `runProjectManager`; Task 2 `runWaves`; E4 `WaveEngineDeps`/`WaveEngineResult`; D `WorktreeManager`/`WorktreeSession`/`PRAdapter`; F2 `ReviewDeps`/`AskUser`; E3b `AskHuman`; C `runToCompletion`/`RoleAgentOptions`; E3a `readOnlyRegistry`; E1 `Board`.
- Produces:
  - `interface JobDeps extends ReviewDeps { manager: WorktreeManager; prAdapter: PRAdapter; rounds: number; askHuman: AskHuman }`
  - `type JobResult = { kind:"chat"; response:string } | { kind:"rejected"; stage:"spec"|"plan" } | { kind:"done"; wave: WaveEngineResult; report: string; session: WorktreeSession }`
  - `runJob(deps: JobDeps, opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string }): Promise<JobResult>`

- [ ] **Step 1: Kırmızı test**

`test/engine/job.test.ts` oluştur:

```typescript
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
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/job.test.ts`
Expected: FAIL — `job.js` yok.

- [ ] **Step 3: job.ts implement**

`src/engine/job.ts` oluştur:

```typescript
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, PRAdapter } from "../worktree/manager.js";
import type { ReviewDeps, AskUser } from "./review.js";
import type { AskHuman } from "./escalation.js";
import { readOnlyRegistry } from "./reviewer.js";
import { runUpstream } from "./upstream.js";
import { runProjectManager } from "./project-manager.js";
import { runWaves } from "./wave-engine.js";
import type { WaveEngineResult } from "./wave-engine.js";

export interface JobDeps extends ReviewDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
  rounds: number;
  askHuman: AskHuman;
}

export type JobResult =
  | { kind: "chat"; response: string }
  | { kind: "rejected"; stage: "spec" | "plan" }
  | { kind: "done"; wave: WaveEngineResult; report: string; session: WorktreeSession };

function pmOpts(deps: JobDeps, workdir: string, planPath: string): RoleAgentOptions {
  const { model, systemPrompt } = deps.roleRegistry.resolve("project-manager");
  return {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `"${planPath}" plan'ını oku ve gerçek task'lara böl (id, title, deps).` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
}

async function runCoachReport(deps: JobDeps, session: WorktreeSession, board: Board): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  const summary = board
    .list()
    .map((c) => `- ${c.id} "${c.title}" [${c.column}]: ${c.stageHistory.map((s) => s.action).join(", ")}`)
    .join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `İş tamamlandı. Board durumu:\n${summary}\nKullanıcıya kısa bir final raporu ver (hangi task'ta ne oldu).` }],
    permission: deps.permission, approve: deps.approve, cwd: session.baseWorktree, signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}

/**
 * Üst-katman iş: openSession → runUpstream → (chat/rejected: kapat) → commit spec/plan →
 * project-manager board → runWaves → coach raporu. done'da session açık bırakılır (G revision).
 */
export async function runJob(
  deps: JobDeps,
  opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string },
): Promise<JobResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  const workdir = session.baseWorktree;
  const up = await runUpstream(deps, workdir, opts.prompt, opts.askUser, opts.maxRounds);

  if (up.kind === "chat") {
    await deps.manager.closeSession(session);
    return { kind: "chat", response: up.response };
  }
  if (up.kind === "rejected") {
    await deps.manager.closeSession(session);
    return { kind: "rejected", stage: up.stage };
  }

  await deps.manager.commitMerge(session, "hc: spec + plan"); // spec/plan → baseBranch (PR'a girer)
  const board = await runProjectManager(pmOpts(deps, workdir, up.planPath));
  const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
  const report = await runCoachReport(deps, session, board);
  return { kind: "done", wave, report, session };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/job.test.ts`
Expected: PASS (chat / rejected / done / abort).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/job.ts test/engine/job.test.ts
git commit -m "feat: runJob (openSession → upstream → board → waves → coach raporu)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 runWaves extract → Task 2; §3 JobDeps/JobResult + §4 runJob/pmOpts/runCoachReport → Task 3; §5 write/edit guard → Task 1; §6 testler → her üç task. Tümü karşılandı.
- **Type consistency:** `JobDeps extends ReviewDeps` + manager/prAdapter/rounds/askHuman → hem `runUpstream` hem `runWaves` (WaveEngineDeps) hem RoleAgentOptions kurulumu için yeterli; `runWaves` `WaveEngineResult` döner.
- **Determinizm:** jobProvider tüm rolleri systemPrompt (+ analyst/planner tool-mesajı) ile keyed → paralel council/wave interleaving-safe; judge counter iki review-loop + PM/wave rolleri.
- **Abort:** runJob/runWaves try/catch'siz → alt katman throw'u propagate; pre-aborted testi doğrular.
- **Geriye dönük uyum:** runWaveEngine imzası değişmedi → E4c testleri Task 2'de yeşil kalır.
