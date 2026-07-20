# Dilim E4b — Conflict-Resolution Council Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge-ortasında bir base worktree'deki çakışmayı konseyle çözen `runConflictCouncil`'ı kurmak: architect diagnoz → senior-coder resolve (shell'siz) → iki-katlı verify (marker taraması + code-reviewer) → `commitMerge`; N tur çözülemezse `abortMerge` + insana sor.

**Architecture:** Önce D `WorktreeManager`'a `unmergedFiles` eklenir + test için `createMergeConflict` helper'ı. Sonra `src/engine/conflict.ts` bu + E3b konsey parçalarını (`ArchitectPlanSchema`, `runReviewer`, `runStructuredRole`, `runToCompletion`) birleştirir. Deterministik marker taraması `fs` ile.

**Tech Stack:** TypeScript ESM, vitest, gerçek tmp git repo (gerçek merge conflict) + MockProvider + scripted askHuman.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD** (önce kırmızı test); **gerçek fs+git** (gerçek merge conflict) + `MockProvider`.
- **Abort yutulmaz:** `runConflictCouncil` try/catch içermez; alt katman throw'u propagate eder.
- **Resolver'da shell yok:** toolset read/write/edit/grep/glob + `buildSkillTool` (mid-merge'de ajan kendi git'ini çalıştırmasın). architect + reviewer salt-okunur.
- **İki-katlı verify:** commit ÖNCESİ (1) deterministik marker taraması (`fs`, kalan `<<<<<<<`) VE (2) `code-reviewer` pass — ikisi de geçmeden `commitMerge` yok.
- **Retry mid-merge'de kalır:** `abortMerge` yalnızca abandon'da; retry base'i merge-ortasında tutar.
- **`rounds` clamp:** `Math.max(1, deps.rounds)`.
- **Ertelenen (E4b değil):** E4a `{conflict}`→E4b bağlantısı, dalga döngüsü, `push`/`openPR`, `removeTask`/`closeSession` → E4c; gerçek `askHuman` → H.

---

### Task 1: `WorktreeManager.unmergedFiles` + `createMergeConflict` test helper

**Files:**
- Modify: `src/worktree/manager.ts` (unmergedFiles metodu)
- Modify: `test/worktree/helpers.ts` (createMergeConflict helper)
- Test: `test/worktree/unmerged.test.ts`

**Interfaces:**
- Consumes: D `WorktreeManager` (private `git`, `deriveTask`, `mergeTask`, `openSession`), E4a `commitTask`; `initTmpRepo`, `defaultGitRunner`.
- Produces:
  - `unmergedFiles(session: WorktreeSession): Promise<string[]>` — base worktree'de unmerged dosyalar.
  - `createMergeConflict(): Promise<{ repo: string; mgr: WorktreeManager; session: WorktreeSession; task: TaskWorktree }>` (helpers.ts) — gerçek merge conflict kuran test util.

- [ ] **Step 1: createMergeConflict helper'ını ekle**

`test/worktree/helpers.ts` sonuna ekle (üstteki import'lara `WorktreeManager` ve tipleri de ekle):

```typescript
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession, TaskWorktree } from "../../src/worktree/manager.js";

/** Gerçek bir merge conflict kurar: base'e shared.txt → aynı base'den A(AAA) ve B(BBB) →
 *  mergeTask(A) merged, mergeTask(B) conflict. Base mid-merge kalır; task = B döner. */
export async function createMergeConflict(): Promise<{
  repo: string; mgr: WorktreeManager; session: WorktreeSession; task: TaskWorktree;
}> {
  const repo = await initTmpRepo();
  const mgr = new WorktreeManager({ repoRoot: repo });
  const session = await mgr.openSession("main", "job");
  const g = (args: string[]) => defaultGitRunner(args, session.baseWorktree);
  await writeFile(join(session.baseWorktree, "shared.txt"), "orig\n", "utf8");
  await g(["add", "-A"]);
  await g(["commit", "-m", "seed shared"]);
  const a = await mgr.deriveTask(session, "task a");
  const b = await mgr.deriveTask(session, "task b");
  await writeFile(join(a.worktree, "shared.txt"), "AAA\n", "utf8");
  await mgr.commitTask(a, "a");
  await writeFile(join(b.worktree, "shared.txt"), "BBB\n", "utf8");
  await mgr.commitTask(b, "b");
  await mgr.mergeTask(session, a); // merged (base shared=AAA)
  await mgr.mergeTask(session, b); // conflict (base mid-merge)
  return { repo, mgr, session, task: b };
}
```

> Not: `helpers.ts` şu an yalnızca `defaultGitRunner`'ı import ediyor; `mkdtemp`/`writeFile` zaten
> import'lu, `join` zaten import'lu. Eksikse ekle. `WorktreeManager` + tipleri yeni import.

- [ ] **Step 2: Kırmızı test — unmergedFiles**

`test/worktree/unmerged.test.ts` oluştur:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { createMergeConflict } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.unmergedFiles", () => {
  it("çakışık dosyaları listeler; abortMerge sonrası []", async () => {
    const c = await createMergeConflict();
    repo = c.repo;
    expect(await c.mgr.unmergedFiles(c.session)).toEqual(["shared.txt"]);
    await c.mgr.abortMerge(c.session);
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]);
  });
});
```

- [ ] **Step 3: Testi çalıştır — kırmızı**

Run: `npx vitest run test/worktree/unmerged.test.ts`
Expected: FAIL — `unmergedFiles` metodu yok.

- [ ] **Step 4: unmergedFiles implement**

`src/worktree/manager.ts` — `mergeTask`'tan sonra (veya `commitTask` yanına) ekle:

```typescript
  /** Base worktree'de git'in unmerged (çakışık) işaretlediği dosyalar. */
  async unmergedFiles(session: WorktreeSession): Promise<string[]> {
    const r = await this.git(["diff", "--name-only", "--diff-filter=U"], session.baseWorktree);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
```

- [ ] **Step 5: Testi çalıştır — yeşil**

Run: `npx vitest run test/worktree/unmerged.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 7: Commit**

```bash
git add src/worktree/manager.ts test/worktree/helpers.ts test/worktree/unmerged.test.ts
git commit -m "feat: WorktreeManager.unmergedFiles + createMergeConflict test helper"
```

---

### Task 2: `runConflictCouncil`

**Files:**
- Create: `src/engine/conflict.ts`
- Test: `test/engine/conflict.test.ts`

**Interfaces:**
- Consumes: Task 1 `unmergedFiles`, `createMergeConflict`; D `WorktreeManager` (`commitMerge`, `abortMerge`), `WorktreeSession`, `TaskWorktree`; E3b `EscalationDeps`, `AskHuman`; `ArchitectPlanSchema` (council.js); `readOnlyRegistry`, `runReviewer` (reviewer.js); E0 `runStructuredRole`; C `runToCompletion`; tool'lar (read/write/edit/grep/glob), `buildSkillTool`; E1 `Board`.
- Produces:
  - `interface ConflictDeps extends EscalationDeps { manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge"> }`
  - `type ConflictResult = { status: "resolved" } | { status: "unresolved"; task: TaskWorktree }`
  - `runConflictCouncil(deps: ConflictDeps, session: WorktreeSession, board: Board, taskId: string, task: TaskWorktree): Promise<ConflictResult>`

- [ ] **Step 1: Kırmızı test — 6 senaryo**

`test/engine/conflict.test.ts` oluştur:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runConflictCouncil } from "../../src/engine/conflict.js";
import type { ConflictDeps } from "../../src/engine/conflict.js";
import type { AskHuman } from "../../src/engine/escalation.js";
import { createMergeConflict } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

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
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface COpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function cdeps(provider: MockProvider, manager: ConflictDeps["manager"], opts: COpts = {}): ConflictDeps {
  const roles: Record<string, RoleConfig> = {
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
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
  };
}
const hasContent = (p: MockProvider, needle: string): boolean =>
  p.requests.some((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes(needle)));

describe("runConflictCouncil", () => {
  it("resolved: architect → resolver(marker'sız) → reviewer pass → commitMerge", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"iki taraf shared.txt değişti","plan":["birleştir"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]);
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
    const actions = board.get("t1")!.stageHistory.map((s) => s.action);
    expect(actions).toContain("conflict:diagnosed");
    expect(actions).toContain("conflict:merged");
  });

  it("marker kalırsa fail → retry; ikinci attempt marker'sız → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< HEAD\nAAA\n=======\nBBB\n>>>>>>>\n"), doneTurn,
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
  });

  it("reviewer fail → retry; ipucu ikinci architect'e taşınır → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "M1\n"), doneTurn,
      submit('{"verdict":"fail","notes":["yanlış-birleşim-ABC"]}'),
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "M2\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("M2\n");
    expect(hasContent(p, "yanlış-birleşim-ABC")).toBe(true);
  });

  it("N tükendi → askHuman abandon → abortMerge → {unresolved}", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< kal\n"), doneTurn,
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("unresolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]); // abortMerge → merge öncesine döndü
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("conflict:aborted");
  });

  it("N tükendi → askHuman retry(ipucu) → ikinci tur resolved; ipucu architect'e taşınır", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["insan-ipucu-XYZ"] }; };
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< kal\n"), doneTurn,
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(asked).toBe(1);
    expect(hasContent(p, "insan-ipucu-XYZ")).toBe(true);
  });

  it("pre-aborted signal → fırlatır (yutulmaz)", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const ac = new AbortController(); ac.abort();
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([submit('{"rootCause":"x","plan":["y"]}')]);
    await expect(
      runConflictCouncil(cdeps(p, c.mgr, { signal: ac.signal }), c.session, board, "t1", c.task),
    ).rejects.toThrow();
  });

  it("bilinmeyen task → hata", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const p = new MockProvider([]);
    await expect(
      runConflictCouncil(cdeps(p, c.mgr), c.session, new Board(), "yok", c.task),
    ).rejects.toThrow(/bilinmeyen task/);
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/conflict.test.ts`
Expected: FAIL — `conflict.js` yok.

- [ ] **Step 3: conflict.ts implement**

`src/engine/conflict.ts` oluştur:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry, runReviewer } from "./reviewer.js";
import { ArchitectPlanSchema } from "./council.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";

export interface ConflictDeps extends EscalationDeps {
  manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge">;
}

export type ConflictResult = { status: "resolved" } | { status: "unresolved"; task: TaskWorktree };

/** Resolver toolset: dosya düzenleme (read/write/edit/grep/glob) + skill — SHELL YOK. */
function resolverRegistry(deps: ConflictDeps): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  return r;
}

/** Verilen dosyalardan herhangi biri hâlâ bir çakışma marker'ı (`<<<<<<<`) içeriyor mu. */
async function hasConflictMarkers(baseWorktree: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    try {
      const content = await readFile(join(baseWorktree, f), "utf8");
      if (content.includes("<<<<<<<")) return true;
    } catch {
      // dosya çözümde silinmiş olabilir (delete/modify) → marker yok say
    }
  }
  return false;
}

/**
 * Mid-merge base worktree'deki çakışmayı konseyle çözer: architect diagnoz → senior-coder resolve
 * (shell'siz) → marker taraması + code-reviewer → commitMerge. N tur çözülemezse abortMerge + insana sor.
 */
export async function runConflictCouncil(
  deps: ConflictDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
  task: TaskWorktree,
): Promise<ConflictResult> {
  if (!board.get(taskId)) throw new Error(`runConflictCouncil: bilinmeyen task: ${taskId}`);
  const conflicted = await deps.manager.unmergedFiles(session);
  const rounds = Math.max(1, deps.rounds);
  const base = session.baseWorktree;

  for (;;) {
    for (let i = 0; i < rounds; i++) {
      const card = board.get(taskId)!;
      const notes = card.reviewNotes.length
        ? `\nİpuçları:\n${card.reviewNotes.map((n) => `- ${n}`).join("\n")}`
        : "";

      // 1. architect diagnoz (salt-okunur)
      const arch = deps.roleRegistry.resolve("architect");
      const diagOpts: RoleAgentOptions = {
        provider: deps.provider, model: arch.model, systemPrompt: arch.systemPrompt,
        tools: readOnlyRegistry(deps),
        messages: [{ role: "user", content:
          `Base worktree'de şu dosyalarda merge çakışması var: ${conflicted.join(", ")}. ` +
          `Kök-nedeni belirle ve somut bir çözüm planı üret.${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
      };
      const plan = await runStructuredRole(diagOpts, ArchitectPlanSchema);
      board.appendStage(taskId, { role: "architect", action: "conflict:diagnosed", note: plan.rootCause });

      // 2. senior-coder resolve (shell yok)
      const sr = deps.roleRegistry.resolve("senior-coder");
      const resolveOpts: RoleAgentOptions = {
        provider: deps.provider, model: sr.model, systemPrompt: sr.systemPrompt,
        tools: resolverRegistry(deps),
        messages: [{ role: "user", content:
          `Base worktree'de şu dosyalardaki merge çakışmalarını çöz (tüm çakışma marker'larını ` +
          `— <<<<<<< / ======= / >>>>>>> — kaldır, iki değişikliği tutarlı biçimde birleştir): ` +
          `${conflicted.join(", ")}.\nPlan:\n${plan.plan.map((p) => `- ${p}`).join("\n")}${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
      };
      await runToCompletion(resolveOpts);
      board.appendStage(taskId, { role: "senior-coder", action: "conflict:resolved-attempt" });

      // 3. verify: deterministik marker taraması + code-reviewer
      if (await hasConflictMarkers(base, conflicted)) {
        board.addReviewNote(taskId, `çakışma marker'ları hâlâ var: ${conflicted.join(", ")}`);
        continue;
      }
      const v = await runReviewer(deps, board.get(taskId)!, base);
      if (v.verdict === "pass") {
        await deps.manager.commitMerge(session, `hc: conflict çözümü — ${card.title}`);
        board.appendStage(taskId, { role: "code-reviewer", action: "conflict:merged" });
        return { status: "resolved" };
      }
      board.clearReviewNotes(taskId);
      for (const n of v.notes) board.addReviewNote(taskId, n);
    }

    // rounds tükendi, base hâlâ mid-merge → insana sor
    const decision = await deps.askHuman({
      card: board.get(taskId)!,
      verdict: { verdict: "fail", notes: [`merge conflict ${rounds} turda çözülemedi`] },
    });
    if (decision.action === "retry") {
      board.clearReviewNotes(taskId);
      for (const n of decision.notes) board.addReviewNote(taskId, n);
      continue;
    }
    // accept/abandon → abort (marker'lı/eksik commit olmaz)
    await deps.manager.abortMerge(session);
    board.appendStage(taskId, { role: "human", action: "conflict:aborted" });
    return { status: "unresolved", task };
  }
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/conflict.test.ts`
Expected: PASS (7 test).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/conflict.ts test/engine/conflict.test.ts
git commit -m "feat: runConflictCouncil (architect diagnoz + senior resolve + verify + commitMerge)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 unmergedFiles → Task 1; §3 ConflictDeps/ConflictResult → Task 2 tipleri; §4 flow (architect→resolver→marker taraması+reviewer→commitMerge; rounds→askHuman retry/abandon→abortMerge) → Task 2 `runConflictCouncil`; §5 testler → her iki task. Tümü karşılandı.
- **Type consistency:** `ConflictDeps extends EscalationDeps` + dar `manager` Pick'i; `runReviewer(deps,...)` ConflictDeps'i TaskCycleDeps olarak kabul eder (extends zinciri); `ArchitectPlanSchema` reuse (council.js).
- **İki-katlı verify:** marker taraması (fs) reviewer'dan ÖNCE; ikisi de geçmeden `commitMerge` yok — resolved testi marker'sız+pass, marker/reviewer-fail testleri retry'i doğrular.
- **Abort:** try/catch yok → propagate; pre-aborted testi rejection'ı doğrular.
- **Resolver shell yok:** `resolverRegistry` write/edit dahil ama shell hariç.
