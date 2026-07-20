# Dilim E4c — Dalga Motoru + Session + PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E4'ü tamamlayan `runWaveEngine`'i kurmak: openSession → team-lead dalgaları → her dalga paralel `runWaveTask` (mutex ile serileştirilmiş merge, conflict merge-kilidi içinde çözülür) → başarısız task'ın bağımlıları atlanır → hepsi başarılıysa push+openPR, değilse `{partial}`.

**Architecture:** Önce E4a `runWaveTask`'a `resolveConflict` seam'i (conflict merge kilidi içinde çözülür). Sonra `wave-engine.ts`: `createMutex` (söz-zinciri) + `runWave` (block-dependents skip + paralel) + `runWaveEngine` (session + team-lead + dalga döngüsü + PR-on-full-success).

**Tech Stack:** TypeScript ESM, vitest, gerçek tmp git repo (+ bare remote) + içerik-tabanlı deterministik provider + fake PRAdapter.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; gerçek fs+git; paralel task'lar için **içerik-tabanlı provider** (system prompt + task başlığına göre yanıt) — `MockProvider` global-index'i paralelde nondeterministik.
- **Abort yutulmaz:** `runWave`/`runWaveEngine` alt katman throw'unu (abort dahil) propagate eder; `wrap` yalnız non-abort council throw'unda `abortMerge` edip devam eder.
- **Geriye dönük uyum:** `resolveConflict` opsiyonel; yoksa `runWaveTask` bugünkü conflict-relay davranışını korur (E4a testleri geçer).
- **PR yalnız tam başarıda:** herhangi failed/skipped → PR yok, `{partial}`.
- **Ertelenen (E4c değil):** `closeSession`/cleanup, coach raporu, gerçek MCP PRAdapter → G/H.

---

### Task 1: `runWaveTask` `resolveConflict` seam'i (E4a genişletmesi)

**Files:**
- Modify: `src/engine/wave-task.ts`
- Modify: `test/engine/wave-task.test.ts`

**Interfaces:**
- Consumes: D `MergeResult`, `TaskWorktree`.
- Produces: `WaveTaskDeps` kazanır `resolveConflict?: (task: TaskWorktree, files: string[]) => Promise<MergeResult>`; conflict'te (varsa) çağrılır, dönüşü merge sonucu olarak kullanılır.

- [ ] **Step 1: Kırmızı test — resolveConflict {merged}/{conflict}**

`test/engine/wave-task.test.ts` — `WOpts`'a `resolveConflict` ekle (mevcut `interface WOpts { ... }`):

```typescript
interface WOpts { rounds?: number; askHuman?: AskHuman; serialize?: <T>(fn: () => Promise<T>) => Promise<T>; signal?: AbortSignal; resolveConflict?: WaveTaskDeps["resolveConflict"] }
```

`wdeps`'in dönüşüne ekle (mevcut `serialize: opts.serialize,` yanına):

```typescript
    resolveConflict: opts.resolveConflict,
```

`describe("runWaveTask", ...)` içine iki test ekle:

```typescript
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
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/wave-task.test.ts`
Expected: FAIL — `resolveConflict` henüz çağrılmıyor (merged beklenirken conflict döner).

- [ ] **Step 3: wave-task.ts'i genişlet**

Import satırına `MergeResult` ekle:

```typescript
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult } from "../worktree/manager.js";
```

`WaveTaskDeps`'e alan ekle (mevcut `serialize?` altına):

```typescript
  /** Conflict'i serileştirilmiş merge bloğu içinde çözer (E4c wiring: runConflictCouncil). */
  resolveConflict?: (task: TaskWorktree, files: string[]) => Promise<MergeResult>;
```

Merge bloğunu değiştir — mevcut:

```typescript
  await deps.manager.commitTask(tw, `hc: ${card.title}`);
  const mr = await ser(() => deps.manager.mergeTask(session, tw));
```

yerine:

```typescript
  await deps.manager.commitTask(tw, `hc: ${card.title}`);
  const mr = await ser(async () => {
    const r = await deps.manager.mergeTask(session, tw);
    if (r.status === "conflict" && deps.resolveConflict) return deps.resolveConflict(tw, r.files);
    return r;
  });
```

(Alt taraf — `if (mr.status === "merged") … else conflict` — aynen kalır.)

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/wave-task.test.ts`
Expected: PASS (mevcut + 2 yeni test; `resolveConflict` yokken conflict davranışı korunur).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/wave-task.ts test/engine/wave-task.test.ts
git commit -m "feat: runWaveTask resolveConflict seam (conflict merge kilidi içinde çözülür)"
```

---

### Task 2: `createMutex` + `runWave`

**Files:**
- Create: `src/engine/wave-engine.ts`
- Test: `test/engine/wave-engine.test.ts`

**Interfaces:**
- Consumes: Task 1 `runWaveTask`/`WaveTaskDeps`; E4b `runConflictCouncil`; D `WorktreeManager`/`WorktreeSession`/`PRAdapter`/`MergeResult`/`TaskWorktree`; E3b `EscalationDeps`; E1 `Board`.
- Produces:
  - `createMutex(): <T>(fn: () => Promise<T>) => Promise<T>`
  - `interface WaveEngineDeps extends EscalationDeps { manager: WorktreeManager; prAdapter: PRAdapter }`
  - `interface WaveOutcome { merged: string[]; failed: string[]; skipped: string[] }`
  - `runWave(deps: WaveEngineDeps, session: WorktreeSession, board: Board, taskIds: string[], blocked: Set<string>): Promise<WaveOutcome>`

- [ ] **Step 1: Kırmızı test — createMutex + runWave**

`test/engine/wave-engine.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutex, runWave } from "../../src/engine/wave-engine.js";
import type { WaveEngineDeps } from "../../src/engine/wave-engine.js";
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

// İçerik-tabanlı deterministik provider: system prompt (rol) + mesajdaki task başlığına göre yanıt.
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
      // coder / senior / team-lead / diğer → no-op (submit yok)
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
  it("eşzamanlı çağrılar sıralı koşar (örtüşme yok)", async () => {
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
  it("all-pass (paralel): iki task da merged", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      board.addCard({ id: "t2", title: "gorev-b" });
      const o = await runWave(edeps(mgr, fakeAdapter()), session, board, ["t1", "t2"], new Set());
      expect(o.merged.sort()).toEqual(["t1", "t2"]);
      expect(o.failed).toEqual([]);
      expect(o.skipped).toEqual([]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("one-fail: başarısız task failed, diğeri merged", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      board.addCard({ id: "t2", title: "gorev-b" });
      const o = await runWave(edeps(mgr, fakeAdapter(), { failTasks: ["gorev-a"] }), session, board, ["t1", "t2"], new Set());
      expect(o.failed).toEqual(["t1"]);
      expect(o.merged).toEqual(["t2"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("skip: blocked bağımlılık → task atlanır (koşmaz)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t3", title: "gorev-c", deps: ["t1"] });
      const o = await runWave(edeps(mgr, fakeAdapter()), session, board, ["t3"], new Set(["t1"]));
      expect(o.skipped).toEqual(["t3"]);
      expect(o.merged).toEqual([]);
      expect(board.get("t3")!.stageHistory.some((s) => s.action === "skipped")).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: FAIL — `wave-engine.js` yok.

- [ ] **Step 3: wave-engine.ts (createMutex + runWave) implement**

`src/engine/wave-engine.ts` oluştur:

```typescript
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { runConflictCouncil } from "./conflict.js";

export interface WaveEngineDeps extends EscalationDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
}

export interface WaveOutcome {
  merged: string[];
  failed: string[];
  skipped: string[];
}

/** Söz-zinciri mutex: her çağrı öncekinin ardından koşar; sonucu/hatasını aynen döndürür. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Tek dalga: blocked bağımlılığa sahip task'ları atla; kalanları paylaşımlı mutex +
 * resolveConflict (merge kilidi içinde runConflictCouncil) ile paralel koş; sonuçları sınıfla.
 */
export async function runWave(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  taskIds: string[],
  blocked: Set<string>,
): Promise<WaveOutcome> {
  const skipped = taskIds.filter((t) => board.get(t)!.deps.some((d) => blocked.has(d)));
  const runnable = taskIds.filter((t) => !skipped.includes(t));
  for (const t of skipped) {
    board.appendStage(t, { role: "team-lead", action: "skipped", note: "bağımlılık başarısız" });
  }

  const ser = createMutex();
  const results = await Promise.all(
    runnable.map(async (t) => {
      const resolveConflict = async (tw: TaskWorktree, files: string[]): Promise<MergeResult> => {
        try {
          const r = await runConflictCouncil(deps, session, board, t, tw);
          return r.status === "resolved" ? { status: "merged" } : { status: "conflict", files };
        } catch (e) {
          if (deps.signal.aborted) throw e;
          try { await deps.manager.abortMerge(session); } catch { /* zaten temiz olabilir */ }
          return { status: "conflict", files };
        }
      };
      const res = await runWaveTask({ ...deps, serialize: ser, resolveConflict }, session, board, t);
      return { t, status: res.status };
    }),
  );

  return {
    merged: results.filter((r) => r.status === "merged").map((r) => r.t),
    failed: results.filter((r) => r.status !== "merged").map((r) => r.t),
    skipped,
  };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: PASS (createMutex + 3 runWave testi).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/wave-engine.ts test/engine/wave-engine.test.ts
git commit -m "feat: createMutex + runWave (block-dependents skip + paralel + conflict wiring)"
```

---

### Task 3: `runWaveEngine`

**Files:**
- Modify: `src/engine/wave-engine.ts` (runWaveEngine + teamLeadOpts ekle)
- Modify: `test/engine/wave-engine.test.ts` (runWaveEngine testleri)

**Interfaces:**
- Consumes: Task 2 `runWave`; E2 `runTeamLead`; D `openSession`/`push`/`openPR`; C `RoleAgentOptions`; B2 `ToolRegistry`; E-skills `buildSkillTool`.
- Produces:
  - `type WaveEngineResult = { status: "completed"; session: WorktreeSession; pr: { url: string }; waves: string[][] } | { status: "partial"; session: WorktreeSession; failed: string[]; skipped: string[]; waves: string[][] }`
  - `runWaveEngine(deps: WaveEngineDeps, board: Board, opts: { fromBranch: string; jobName: string; prTitle?: string }): Promise<WaveEngineResult>`

- [ ] **Step 1: Kırmızı test — completed + partial**

`test/engine/wave-engine.test.ts`'e import ekle (üste):

```typescript
import { runWaveEngine } from "../../src/engine/wave-engine.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
```

Yeni describe ekle:

```typescript
describe("runWaveEngine", () => {
  it("completed: hepsi pass → push + openPR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      board.addCard({ id: "t2", title: "gorev-b", deps: ["t1"] });
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

  it("partial: t1 fail → t2(dep t1) skip → PR açılmaz", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      board.addCard({ id: "t2", title: "gorev-b", deps: ["t1"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter, { failTasks: ["gorev-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(adapter.calls).toBe(0);
      if (res.status === "partial") {
        expect(res.failed).toEqual(["t1"]);
        expect(res.skipped).toEqual(["t2"]);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("abort: pre-aborted signal → fırlatır", async () => {
    const repo = await initTmpRepo();
    try {
      const ac = new AbortController();
      ac.abort();
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "gorev-a" });
      await expect(
        runWaveEngine(edeps(mgr, fakeAdapter(), { signal: ac.signal }), board, { fromBranch: "main", jobName: "job" }),
      ).rejects.toThrow();
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: FAIL — `runWaveEngine` export yok.

- [ ] **Step 3: runWaveEngine + teamLeadOpts implement**

`src/engine/wave-engine.ts`'e import'ları ekle (üstteki import bloğuna):

```typescript
import type { RoleAgentOptions } from "../agent/loop.js";
import { runTeamLead } from "./team-lead.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
```

Dosya sonuna ekle:

```typescript
export type WaveEngineResult =
  | { status: "completed"; session: WorktreeSession; pr: { url: string }; waves: string[][] }
  | { status: "partial"; session: WorktreeSession; failed: string[]; skipped: string[]; waves: string[][] };

function teamLeadOpts(deps: WaveEngineDeps, session: WorktreeSession): RoleAgentOptions {
  const tl = deps.roleRegistry.resolve("team-lead");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  return {
    provider: deps.provider, model: tl.model, systemPrompt: tl.systemPrompt,
    tools, messages: [], permission: deps.permission, approve: deps.approve,
    cwd: session.baseWorktree, signal: deps.signal,
  };
}

/**
 * Deterministik dış döngü: openSession → team-lead dalgaları → her dalga paralel runWave
 * (başarısızın bağımlıları atlanır) → tüm task'lar başarılıysa push+openPR, değilse {partial}.
 */
export async function runWaveEngine(
  deps: WaveEngineDeps,
  board: Board,
  opts: { fromBranch: string; jobName: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  const waves = await runTeamLead(teamLeadOpts(deps, session), board);

  const blocked = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wave of waves) {
    const o = await runWave(deps, session, board, wave, blocked);
    for (const t of o.failed) { blocked.add(t); failed.push(t); }
    for (const t of o.skipped) { blocked.add(t); skipped.push(t); }
    // başarılı merge'ler base'e commit'lendi → sonraki dalga güncellenmiş base'den türer (D otomatik)
  }

  if (failed.length === 0 && skipped.length === 0) {
    await deps.manager.push(session);
    const body = "Tamamlanan task'lar:\n" + board.list().map((c) => `- ${c.title}`).join("\n");
    const pr = await deps.manager.openPR(session, deps.prAdapter, {
      base: opts.fromBranch,
      title: opts.prTitle ?? `hc: ${opts.jobName}`,
      body,
    });
    return { status: "completed", session, pr, waves };
  }
  return { status: "partial", session, failed, skipped, waves };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/wave-engine.test.ts`
Expected: PASS (createMutex + runWave + 3 runWaveEngine testi).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/wave-engine.ts test/engine/wave-engine.test.ts
git commit -m "feat: runWaveEngine (openSession + team-lead dalgalar + PR-on-full-success)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 resolveConflict seam → Task 1; §3.1 createMutex + §3.2 runWave → Task 2; §3.3 runWaveEngine → Task 3; §5 testler (içerik-tabanlı provider, bare remote, block-dependents, PR-on-success) → her üç task. Tümü karşılandı.
- **Type consistency:** `WaveEngineDeps extends EscalationDeps` + `manager: WorktreeManager` → hem `runWaveTask` (WaveTaskManager Pick) hem `runConflictCouncil` (ConflictDeps Pick) için yeterli; `resolveConflict` dönüşü `MergeResult` ile runWaveTask merge dalına uyar.
- **Determinizm:** paralel task'lar içerik-tabanlı provider ile keyed → interleaving önemsiz; team-lead submit üretmez → computeWaves fallback → dalgalar board deps'inden.
- **Abort:** runWave `Promise.all` alt katman throw'unu propagate eder; `wrap` yalnız non-abort council throw'unda abortMerge; pre-aborted testi rejection'ı doğrular.
- **PR-on-full-success:** partial testte `adapter.calls === 0` doğrular; completed testte bare remote + `calls === 1`.
