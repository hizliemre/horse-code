# Dilim E4a — Task-in-Wave Yaşam Döngüsü Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bir task'ı dalga içinde uçtan uca koşan `runWaveTask`'ı kurmak: base'den worktree türet → escalation ile koş → geçerse commit + base'e merge → `{merged|conflict|task-failed}`.

**Architecture:** Önce D `WorktreeManager`'a `commitTask` eklenir (task worktree değişikliklerini task branch'ine commit'ler; E3 commit yapmadığından merge'in bir şey taşıması için şart). Sonra `src/engine/wave-task.ts` bu + `deriveTask`/`mergeTask` (D) + `runTaskWithEscalation` (E3b) birleştirir. Conflict yalnızca relay edilir; çözüm/orkestrasyon E4b/E4c.

**Tech Stack:** TypeScript ESM, vitest, gerçek tmp git repo (`initTmpRepo`) + MockProvider + stub manager.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD** (önce kırmızı test); merged/task-failed **gerçek fs+git** (`test/worktree/helpers.js` → `initTmpRepo`), conflict/clamp/abort **stub manager**.
- **Abort yutulmaz:** `runWaveTask` try/catch içermez; alt katman throw'u propagate eder.
- **commitTask no-op toleransı:** task worktree'de değişiklik yoksa commit **atlanır** (hata fırlatmaz).
- **Ertelenen (E4a değil):** `commitMerge` (temiz merge zaten commit'li), `abortMerge`/conflict çözümü (E4b), `removeTask`/`closeSession` (E4c/G/H), gerçek `askHuman`/config `rounds` okuma (H/E4c).
- **serialize seam'i:** git-mutating adımlar (`deriveTask`, `mergeTask`) `deps.serialize` içinden geçer (varsayılan kimlik); `commitTask` per-worktree olduğundan serialize'siz. Gerçek mutex E4c'de.
- **rounds clamp:** `Math.max(1, deps.rounds)` (E3b M2: `rounds<1` cheap tier'ları atlamasın).

---

### Task 1: `WorktreeManager.commitTask`

**Files:**
- Modify: `src/worktree/manager.ts` (commitTask metodu ekle)
- Test: `test/worktree/commit-task.test.ts`

**Interfaces:**
- Consumes: D `WorktreeManager` (private `run`/`git`), `TaskWorktree`; `initTmpRepo` (test helper), `defaultGitRunner`.
- Produces: `commitTask(task: TaskWorktree, message: string): Promise<void>` — task worktree'sindeki tüm değişiklikleri task branch'ine commit'ler; staged değişiklik yoksa no-op.

- [ ] **Step 1: Kırmızı test — commitTask commit'ler ve boşta no-op**

`test/worktree/commit-task.test.ts` oluştur:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.commitTask", () => {
  it("task worktree değişikliklerini task branch'ine commit'ler", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    const tw = await mgr.deriveTask(s, "task a");
    await writeFile(join(tw.worktree, "a.txt"), "hi", "utf8");
    await mgr.commitTask(tw, "hc: task a");
    const log = await defaultGitRunner(["log", "--oneline", tw.branch], repo);
    expect(log.stdout).toContain("hc: task a");
  });

  it("değişiklik yokken no-op (hata yok, yeni commit yok)", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    const tw = await mgr.deriveTask(s, "task b");
    await mgr.commitTask(tw, "hc: task b"); // hiç değişiklik yok
    const log = await defaultGitRunner(["log", "--oneline", tw.branch], repo);
    expect(log.stdout).not.toContain("hc: task b");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/worktree/commit-task.test.ts`
Expected: FAIL — `commitTask` metodu yok.

- [ ] **Step 3: commitTask implement**

`src/worktree/manager.ts` — `commitMerge` metodundan sonra ekle:

```typescript
  /** Task worktree'sindeki tüm değişiklikleri task branch'ine commit'ler; değişiklik yoksa no-op. */
  async commitTask(task: TaskWorktree, message: string): Promise<void> {
    await this.run(["add", "-A"], task.worktree);
    const staged = await this.git(["diff", "--cached", "--quiet"], task.worktree);
    if (staged.code === 0) return; // fark yok → no-op
    await this.run(["commit", "-m", message], task.worktree);
  }
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/worktree/commit-task.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/worktree/manager.ts test/worktree/commit-task.test.ts
git commit -m "feat: WorktreeManager.commitTask (task worktree → task branch commit)"
```

---

### Task 2: `runWaveTask` (task-in-wave yaşam döngüsü)

**Files:**
- Create: `src/engine/wave-task.ts`
- Test: `test/engine/wave-task.test.ts`

**Interfaces:**
- Consumes: Task 1 `commitTask`; D `WorktreeManager` (`deriveTask`, `mergeTask`), `WorktreeSession`, `TaskWorktree`; E3b `runTaskWithEscalation`, `EscalationDeps`, `AskHuman`; E1 `Board`.
- Produces:
  - `type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">`
  - `interface WaveTaskDeps extends EscalationDeps { manager: WaveTaskManager; serialize?: <T>(fn: () => Promise<T>) => Promise<T> }`
  - `type TaskResult = { status: "merged"; task: TaskWorktree } | { status: "conflict"; files: string[]; task: TaskWorktree } | { status: "task-failed"; task: TaskWorktree }`
  - `runWaveTask(deps: WaveTaskDeps, session: WorktreeSession, board: Board, taskId: string): Promise<TaskResult>`

- [ ] **Step 1: Kırmızı test — 6 senaryo**

`test/engine/wave-task.test.ts` oluştur:

```typescript
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

interface WOpts { rounds?: number; askHuman?: AskHuman; serialize?: <T>(fn: () => Promise<T>) => Promise<T>; signal?: AbortSignal }
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
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/wave-task.test.ts`
Expected: FAIL — `wave-task.js` yok.

- [ ] **Step 3: wave-task.ts implement**

`src/engine/wave-task.ts` oluştur:

```typescript
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import { runTaskWithEscalation, type EscalationDeps } from "./escalation.js";

/** E4a yalnızca bu üç metodu kullanır (stub/mock enjeksiyonu için dar arayüz). */
export type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">;

export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  /** Git-mutating adımları (derive, merge) serileştiren mutex; paralel dalgada E4c sağlar.
   *  Varsayılan: kimlik. */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type TaskResult =
  | { status: "merged"; task: TaskWorktree }
  | { status: "conflict"; files: string[]; task: TaskWorktree }
  | { status: "task-failed"; task: TaskWorktree };

/**
 * Bir task'ın dalga içi yaşam döngüsü: base'den worktree türet → escalation ile koş →
 * geçerse worktree'yi commit'le + base'e merge. Conflict yalnızca relay edilir (çözüm E4b).
 */
export async function runWaveTask(
  deps: WaveTaskDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
): Promise<TaskResult> {
  const card = board.get(taskId);
  if (!card) throw new Error(`runWaveTask: bilinmeyen task: ${taskId}`);

  const ser = deps.serialize ?? (<T>(f: () => Promise<T>) => f());
  const tw = await ser(() => deps.manager.deriveTask(session, card.title));

  const rounds = Math.max(1, deps.rounds);
  const v = await runTaskWithEscalation({ ...deps, rounds }, board, taskId, tw.worktree);

  if (v.verdict === "fail") {
    board.appendStage(taskId, { role: "team-lead", action: "task-failed" });
    return { status: "task-failed", task: tw };
  }

  // pass → worktree değişikliklerini task branch'ine commit'le, sonra base'e merge et
  await deps.manager.commitTask(tw, `hc: ${card.title}`);
  const mr = await ser(() => deps.manager.mergeTask(session, tw));
  if (mr.status === "merged") {
    board.appendStage(taskId, { role: "team-lead", action: "merged" });
    return { status: "merged", task: tw };
  }
  board.appendStage(taskId, { role: "team-lead", action: "merge-conflict", note: mr.files.join(", ") });
  return { status: "conflict", files: mr.files, task: tw };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/wave-task.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/wave-task.ts test/engine/wave-task.test.ts
git commit -m "feat: runWaveTask (derive → escalate → commit → merge, TaskResult union)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 WaveTaskManager/WaveTaskDeps/TaskResult → Task 2 tipleri; §3 flow (derive→escalate→commit→merge, task-failed/conflict dalları) → Task 2 `runWaveTask`; commit adımı (§1 not) → Task 1 `commitTask` + Task 2 çağrısı; §4 testler → her iki task'ın testleri (commitTask + 6 senaryo). Tümü karşılandı.
- **Type consistency:** `WaveTaskManager = Pick<..., "deriveTask"|"commitTask"|"mergeTask">` (Task 2) Task 1'in eklediği `commitTask`'ı içerir; `WaveTaskDeps extends EscalationDeps` (E3b); `TaskResult` union üç dalın hepsini kapsar.
- **Abort:** `runWaveTask`'ta try/catch yok → escalation/git throw'u propagate eder; pre-aborted testi rejection'ı doğrular.
- **commit adımı:** merged testi commit olmadan geçmez (base dosyayı almaz) → commit+merge zinciri gerçekten doğrulanır.
