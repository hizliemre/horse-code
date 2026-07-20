# Dilim E3b — Task-seviyesi Escalation Merdiveni Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E3a'nın tek-tur `runTaskCycle`'ını, takılan task'ı yükselten çok-turlu escalation merdiveniyle (implementer → senior → konsey → insana sor) sarmalamak.

**Architecture:** `runCycleWithRole` (E3a'dan extract, açık rol) → `runEscalationCouncil` (architect diagnoz + senior implement + son review) → `runTaskWithEscalation` (route→aile, `tierOf(attempts/N)` ile rol yükseltme, konsey fail'de `askHuman` seam'i). Board mutasyonları E1 primitiflerini kullanır; tüm ajanlar MockProvider ile test edilir.

**Tech Stack:** TypeScript ESM, zod, vitest, MockProvider + gerçek tmp worktree dizinleri.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict: true`; **relative import'lar `.js` son ekli**.
- zod ile şema doğrulama; structured çıktı `runStructuredRole` + zod şeması ile.
- vitest, **TDD** (önce kırmızı test); ağ YOK (`MockProvider`) + gerçek fs (`mkdtemp` tmp worktree).
- **Abort yutulmaz:** abort her zaman yukarı `throw` edilir; escalation döngüsünde `catch`-ile-fallback YOK.
- **E3a davranışı korunur:** `runTaskCycle`'ın dış imzası ve mevcut testleri (`test/engine/task-cycle.test.ts`) aynen yeşil kalır.
- **Toolset kuralları:** implementer = `createDefaultRegistry()` + `buildSkillTool`; reviewer/architect = salt-okunur (`read/grep/glob` + `buildSkillTool`, write/edit/shell YOK).
- **E-skills coupling:** rol çalıştırılırken `resolve` (skill enjeksiyonlu) VE toolset'te `buildSkillTool` **birlikte** (mevcut `runImplementer`/`runReviewer` bunu sağlıyor; korunur).
- **Rol adları string:** yeni roller (`senior-coder`, `senior-designer`, `architect`) config'ten `resolve(name)` ile çözülür; kod enum'una gerek yok (yalnızca `RunnableRole` union'ı implementer olarak çalıştırılabilirleri sınırlar).

---

### Task 1: `runCycleWithRole` extract + `RunnableRole` + `runImplementer` genişletme

**Files:**
- Modify: `src/engine/task-types.ts` (RunnableRole ekle)
- Modify: `src/engine/implementer.ts` (role param `RunnableRole`)
- Modify: `src/engine/task-cycle.ts` (runCycleWithRole extract + runTaskCycle refactor)
- Test: `test/engine/task-cycle.test.ts` (senior-coder rolüyle runCycleWithRole testi + mevcut testler yeşil)

**Interfaces:**
- Consumes: E3a `routeTask`, `runImplementer`, `runReviewer`, `TaskCycleDeps`, `Verdict`, `ImplementerRole`; E1 `Board`.
- Produces:
  - `type RunnableRole = "coder" | "designer" | "senior-coder" | "senior-designer"` (task-types.ts)
  - `runCycleWithRole(deps: TaskCycleDeps, board: Board, taskId: string, cwd: string, role: RunnableRole): Promise<Verdict>`
  - `runTaskCycle(deps, board, taskId, worktreePath): Promise<Verdict>` (imza aynı, içi refactor)
  - `runImplementer(deps, role: RunnableRole, task, cwd): Promise<void>` (role tipi genişledi)

- [ ] **Step 1: task-types.ts'e RunnableRole ekle**

`src/engine/task-types.ts` sonuna (ImplementerRole tanımından hemen sonra):

```typescript
export type RunnableRole = ImplementerRole | "senior-coder" | "senior-designer";
```

- [ ] **Step 2: runImplementer'ın role parametresini genişlet**

`src/engine/implementer.ts` — import ve imza:

```typescript
import type { TaskCycleDeps, RunnableRole } from "./task-types.js";
```

```typescript
export async function runImplementer(
  deps: TaskCycleDeps,
  role: RunnableRole,
  task: Card,
  cwd: string,
): Promise<void> {
```

(Gövde aynı kalır — `resolve(role)` string kabul eder; `ImplementerRole` import'u artık kullanılmıyorsa kaldır.)

- [ ] **Step 3: Kırmızı test — runCycleWithRole açık senior-coder ile koşar**

`test/engine/task-cycle.test.ts` — üstteki `deps()` helper'ının `roles`'una `senior-coder` ekle:

```typescript
  const roles = {
    router: { models: ["m"], systemPrompt: "route" },
    coder: { models: ["m"], systemPrompt: "coder" },
    "senior-coder": { models: ["m"], systemPrompt: "senior-coder" },
    "code-reviewer": { models: ["m"], systemPrompt: "reviewer" },
  };
```

Import satırına `runCycleWithRole` ekle:

```typescript
import { runTaskCycle, runCycleWithRole } from "../../src/engine/task-cycle.js";
```

`describe("runTaskCycle", ...)` bloğunun içine yeni test ekle:

```typescript
  it("runCycleWithRole: açık senior-coder rolüyle koşar (routing yok), pass→DONE", async () => {
    // routing turn'ü YOK; ilk turn doğrudan implementer
    const p = new MockProvider([writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}')]);
    const board = boardWithTask();
    const v = await runCycleWithRole(deps(p), board, "t1", dir, "senior-coder");
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    // implementer senior-coder sistem prompt'uyla koştu
    expect(p.requests[0].messages[0].content).toBe("senior-coder");
  });
```

- [ ] **Step 4: Testi çalıştır — kırmızı (runCycleWithRole yok)**

Run: `npx vitest run test/engine/task-cycle.test.ts`
Expected: FAIL — `runCycleWithRole` export edilmiyor.

- [ ] **Step 5: runCycleWithRole extract + runTaskCycle refactor**

`src/engine/task-cycle.ts`'i tümüyle şu içerikle değiştir:

```typescript
import type { Board } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runReviewer } from "./reviewer.js";
import type { TaskCycleDeps, Verdict, RunnableRole } from "./task-types.js";

/** Verilen açık rol ile tek-tur çekirdek (routing YOK): implement → review → Board geçişleri. */
export async function runCycleWithRole(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  cwd: string,
  role: RunnableRole,
): Promise<Verdict> {
  board.move(taskId, "IN-PROGRESS", role);
  await runImplementer(deps, role, board.get(taskId)!, cwd);
  board.move(taskId, "REVIEW", role);

  const v = await runReviewer(deps, board.get(taskId)!, cwd);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
    board.clearReviewNotes(taskId);
    board.move(taskId, "DONE", "code-reviewer");
  } else {
    const notes = v.notes.length > 0 ? v.notes : ["review başarısız (not verilmedi)"];
    board.appendStage(taskId, {
      role: "code-reviewer",
      action: "reviewed:fail",
      note: notes.join("; "),
    });
    board.clearReviewNotes(taskId);
    for (const n of notes) board.addReviewNote(taskId, n);
    board.move(taskId, "TODO", "code-reviewer");
  }
  return v;
}

/** Bir task'ın tek-tur yaşam döngüsü: route → runCycleWithRole. */
export async function runTaskCycle(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  worktreePath: string,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskCycle: bilinmeyen task: ${taskId}`);

  const role = await routeTask(deps, task);
  board.setWorktree(taskId, worktreePath);
  return runCycleWithRole(deps, board, taskId, worktreePath, role);
}
```

- [ ] **Step 6: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/task-cycle.test.ts`
Expected: PASS (yeni test + 5 mevcut E3a testi).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: temiz (implementer.ts'te kullanılmayan `ImplementerRole` import'u kaldırıldıysa uyarı yok).

- [ ] **Step 8: Commit**

```bash
git add src/engine/task-types.ts src/engine/implementer.ts src/engine/task-cycle.ts test/engine/task-cycle.test.ts
git commit -m "refactor: runCycleWithRole extract (açık rol) + RunnableRole + runImplementer genişletme"
```

---

### Task 2: `runEscalationCouncil` (konsey — architect diagnoz + senior implement + son review)

**Files:**
- Modify: `src/engine/reviewer.ts` (`readOnlyRegistry`'yi export et)
- Create: `src/engine/council.ts`
- Test: `test/engine/council.test.ts`

**Interfaces:**
- Consumes: Task 1 `runImplementer(RunnableRole)`, `RunnableRole`; E3a `runReviewer`, `readOnlyRegistry`, `TaskCycleDeps`, `Verdict`, `ImplementerRole`; E0 `runStructuredRole`; E1 `Board`.
- Produces:
  - `ArchitectPlanSchema = z.object({ rootCause: z.string(), plan: z.array(z.string()) })`
  - `runEscalationCouncil(deps: TaskCycleDeps, board: Board, taskId: string, cwd: string, family: ImplementerRole): Promise<Verdict>`
    - Konsey turunun Verdict'ini döner; **DONE'a taşımaz** (insan/DONE kararı Task 3'te).

- [ ] **Step 1: reviewer.ts'te readOnlyRegistry'yi export et**

`src/engine/reviewer.ts` — `function readOnlyRegistry` satırını `export function readOnlyRegistry` yap (gövde aynı).

- [ ] **Step 2: Kırmızı test — konsey pass ve fail**

`test/engine/council.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEscalationCouncil } from "../../src/engine/council.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-council-")); });
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
  const roles: Record<string, RoleConfig> = {
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
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

describe("runEscalationCouncil", () => {
  it("pass: architect diagnoz → senior implement → reviewer pass; stage kayıtları + senior plan görür", async () => {
    // architect submit → senior write → senior done → reviewer pass
    const p = new MockProvider([
      submit('{"rootCause":"eksik test","plan":["testi ekle","kodu düzelt"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    const actions = c.stageHistory.map((s) => s.action);
    expect(actions).toContain("council:diagnosed");
    expect(actions).toContain("council:implemented");
    expect(actions).toContain("reviewed:pass");
    // senior implement (requests[1]) architect planını (reviewNotes) mesajında gördü
    expect(p.requests[1].messages[0].content).toBe("P-senior-coder");
    expect(p.requests[1].messages.some((m) => typeof m.content === "string" && m.content.includes("testi ekle"))).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("kod");
  });

  it("fail: reviewer fail → Verdict fail döner, DONE'a taşınmaz (REVIEW'da kalır)", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"fail","notes":["hâlâ hata"]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("fail");
    expect(v.notes).toEqual(["hâlâ hata"]);
    expect(board.get("t1")!.column).toBe("REVIEW");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("reviewed:fail");
  });

  it("designer ailesi: senior-designer implement eder", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    await runEscalationCouncil(deps(p), board, "t1", dir, "designer");
    expect(p.requests[1].messages[0].content).toBe("P-senior-designer");
  });
});
```

- [ ] **Step 3: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/council.test.ts`
Expected: FAIL — `council.js` yok.

- [ ] **Step 4: council.ts implement**

`src/engine/council.ts` oluştur:

```typescript
import { z } from "zod";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runReviewer, readOnlyRegistry } from "./reviewer.js";
import { runImplementer } from "./implementer.js";
import type { TaskCycleDeps, Verdict, ImplementerRole } from "./task-types.js";

export const ArchitectPlanSchema = z.object({
  rootCause: z.string(),
  plan: z.array(z.string()),
});

/**
 * Escalation konseyi (merdivenin tepesi): architect kök-neden + plan üretir →
 * ailenin senior'ı planı worktree'de uygular → code-reviewer son review.
 * Konsey turunun Verdict'ini döner; DONE/insan kararı çağıran katmanda (runTaskWithEscalation).
 */
export async function runEscalationCouncil(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  cwd: string,
  family: ImplementerRole,
): Promise<Verdict> {
  const task = board.get(taskId)!;

  // 1. architect diagnoz (salt-okunur, structured)
  const { model, systemPrompt } = deps.roleRegistry.resolve("architect");
  const history = task.stageHistory.map((s) => s.action).join(", ");
  const diagnoseOpts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [
      {
        role: "user",
        content:
          `Task "${task.title}" tekrar tekrar review'dan döndü.\n` +
          `Reviewer notları:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}\n` +
          `Geçmiş: ${history}\nKök-nedeni belirle ve somut bir plan üret.`,
      },
    ],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const plan = await runStructuredRole(diagnoseOpts, ArchitectPlanSchema);
  board.appendStage(taskId, { role: "architect", action: "council:diagnosed", note: plan.rootCause });

  // 2. senior implement — plan reviewNotes'a yazılır (E3a "dönen task" yolu)
  const senior = family === "designer" ? "senior-designer" : "senior-coder";
  board.clearReviewNotes(taskId);
  board.addReviewNote(taskId, plan.rootCause);
  for (const step of plan.plan) board.addReviewNote(taskId, step);
  board.move(taskId, "IN-PROGRESS", senior);
  await runImplementer(deps, senior, board.get(taskId)!, cwd);
  board.appendStage(taskId, { role: senior, action: "council:implemented" });
  board.move(taskId, "REVIEW", senior);

  // 3. son review
  const v = await runReviewer(deps, board.get(taskId)!, cwd);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
  } else {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:fail", note: v.notes.join("; ") });
  }
  return v;
}
```

- [ ] **Step 5: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/council.test.ts`
Expected: PASS (3 test).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 7: Commit**

```bash
git add src/engine/reviewer.ts src/engine/council.ts test/engine/council.test.ts
git commit -m "feat: runEscalationCouncil (architect diagnoz + senior implement + son review)"
```

---

### Task 3: `runTaskWithEscalation` (merdiven döngüsü + tier + askHuman seam)

**Files:**
- Create: `src/engine/escalation.ts`
- Test: `test/engine/escalation.test.ts`

**Interfaces:**
- Consumes: Task 1 `runCycleWithRole`, `RunnableRole`; Task 2 `runEscalationCouncil`; E3a `routeTask`, `TaskCycleDeps`, `Verdict`, `ImplementerRole`; E1 `Board`, `Card`.
- Produces:
  - `tierOf(attempts: number, rounds: number): 0 | 1 | 2`
  - `type HumanDecision = { action: "accept" } | { action: "retry"; notes: string[] } | { action: "abandon" }`
  - `type AskHuman = (ctx: { card: Card; verdict: Verdict }) => Promise<HumanDecision>`
  - `interface EscalationDeps extends TaskCycleDeps { rounds: number; askHuman: AskHuman }`
  - `runTaskWithEscalation(deps: EscalationDeps, board: Board, taskId: string, cwd: string): Promise<Verdict>`

- [ ] **Step 1: Kırmızı test — tierOf + merdiven + askHuman dalları**

`test/engine/escalation.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskWithEscalation, tierOf } from "../../src/engine/escalation.js";
import type { EscalationDeps, AskHuman } from "../../src/engine/escalation.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-esc-")); });
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
// Tek-turlu implementer (write yok — reviewer'a hızlı geçiş)
const noopImpl: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface EOpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function edeps(provider: MockProvider, opts: EOpts = {}): EscalationDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    designer: { models: ["m"], systemPrompt: "P-designer" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
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
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X yap" });
  return b;
}
const contents = (p: MockProvider): string[] =>
  p.requests.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")));

describe("tierOf", () => {
  it("attempts/rounds → tier", () => {
    expect(tierOf(0, 1)).toBe(0);
    expect(tierOf(1, 1)).toBe(1);
    expect(tierOf(2, 1)).toBe(2);
    expect(tierOf(0, 3)).toBe(0);
    expect(tierOf(2, 3)).toBe(0);
    expect(tierOf(3, 3)).toBe(1);
    expect(tierOf(5, 3)).toBe(1);
    expect(tierOf(6, 3)).toBe(2);
  });
});

describe("runTaskWithEscalation", () => {
  it("tier ilerlemesi (N=1): coder fail → senior-coder fail → konsey pass → DONE", async () => {
    const p = new MockProvider([
      submit('{"role":"coder"}'),                    // route → coder ailesi
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),   // tier0 coder fail
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),   // tier1 senior-coder fail
      submit('{"rootCause":"x","plan":["p"]}'),      // konsey: architect
      writeTurn(), doneTurn,                         // konsey: senior-coder implement
      submit('{"verdict":"pass","notes":[]}'),       // konsey: reviewer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.attempts).toBe(2);
    // her tier doğru rolü kullandı
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys).toContain("P-coder");
    expect(sys).toContain("P-senior-coder");
    expect(sys).toContain("P-architect");
  });

  it("designer ailesi (N=1): designer fail → senior-designer devralır", async () => {
    const p = new MockProvider([
      submit('{"role":"designer"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),   // tier0 designer fail
      noopImpl, submit('{"verdict":"pass","notes":[]}'),      // tier1 senior-designer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys).toContain("P-designer");
    expect(sys).toContain("P-senior-designer");
  });

  it("konsey fail → askHuman accept → DONE (human:accept), verdict pass", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "accept" }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:accept");
  });

  it("konsey fail → askHuman retry → konsey tekrar; ikinci architect ipucunu görür", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["ipucu-XYZ"] }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'), // konsey1 fail
      submit('{"rootCause":"y","plan":["q"]}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}'),   // konsey2 pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    // retry sonrası ikinci konsey turunun architect mesajı ipucunu (reviewNotes) içerir
    expect(contents(p).some((c) => c.includes("ipucu-XYZ"))).toBe(true);
  });

  it("konsey fail → askHuman abandon → verdict fail, DONE'a taşınmaz (human:abandon)", async () => {
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    expect(board.get("t1")!.column).not.toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:abandon");
  });

  it("bilinmeyen task → hata", async () => {
    const p = new MockProvider([]);
    await expect(runTaskWithEscalation(edeps(p), boardWithTask(), "yok", dir)).rejects.toThrow(/bilinmeyen task/);
  });

  it("iptal edilmişse fırlatır (abort yutulmaz)", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"role":"coder"}')]);
    await expect(
      runTaskWithEscalation(edeps(p, { signal: ac.signal }), boardWithTask(), "t1", dir),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/escalation.test.ts`
Expected: FAIL — `escalation.js` yok.

- [ ] **Step 3: escalation.ts implement**

`src/engine/escalation.ts` oluştur:

```typescript
import type { Board, Card } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runCycleWithRole } from "./task-cycle.js";
import { runEscalationCouncil } from "./council.js";
import type { TaskCycleDeps, Verdict, RunnableRole } from "./task-types.js";

export type HumanDecision =
  | { action: "accept" }
  | { action: "retry"; notes: string[] }
  | { action: "abandon" };

export type AskHuman = (ctx: { card: Card; verdict: Verdict }) => Promise<HumanDecision>;

export interface EscalationDeps extends TaskCycleDeps {
  rounds: number; // tier başına tur (config escalation.rounds; varsayılan 3)
  askHuman: AskHuman;
}

/** attempts + tier başına tur sayısından tier: 0 implementer, 1 senior, 2 konsey. */
export function tierOf(attempts: number, rounds: number): 0 | 1 | 2 {
  return attempts < rounds ? 0 : attempts < 2 * rounds ? 1 : 2;
}

/**
 * Task-seviyesi escalation merdiveni: route→aile, tier(attempts/N) ile rol yükseltme
 * (implementer → senior → konsey). Konsey de çözemezse askHuman seam'i (accept/retry/abandon).
 */
export async function runTaskWithEscalation(
  deps: EscalationDeps,
  board: Board,
  taskId: string,
  cwd: string,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskWithEscalation: bilinmeyen task: ${taskId}`);

  const family = await routeTask(deps, task); // bir kez: coder | designer
  board.setWorktree(taskId, cwd);

  for (;;) {
    const attempts = board.get(taskId)!.attempts;
    const tier = tierOf(attempts, deps.rounds);

    if (tier < 2) {
      const role: RunnableRole =
        tier === 0 ? family : family === "designer" ? "senior-designer" : "senior-coder";
      const v = await runCycleWithRole(deps, board, taskId, cwd, role);
      if (v.verdict === "pass") return v; // runCycleWithRole DONE'a taşıdı
      board.incrementAttempts(taskId); // fail → tier ilerler
      continue;
    }

    // tier 2 — escalation konseyi
    const v = await runEscalationCouncil(deps, board, taskId, cwd, family);
    if (v.verdict === "pass") {
      board.clearReviewNotes(taskId);
      board.move(taskId, "DONE", "code-reviewer");
      return v;
    }

    // konsey fail → insana sor
    const decision = await deps.askHuman({ card: board.get(taskId)!, verdict: v });
    if (decision.action === "accept") {
      board.appendStage(taskId, { role: "human", action: "human:accept" });
      board.clearReviewNotes(taskId);
      board.move(taskId, "DONE", "human");
      return { verdict: "pass", notes: [] };
    }
    if (decision.action === "retry") {
      board.appendStage(taskId, {
        role: "human",
        action: "human:retry",
        note: decision.notes.join("; "),
      });
      board.clearReviewNotes(taskId);
      for (const n of decision.notes) board.addReviewNote(taskId, n);
      board.incrementAttempts(taskId); // tier 2'de kalır, konsey tekrar
      continue;
    }
    // abandon
    board.appendStage(taskId, { role: "human", action: "human:abandon" });
    return { verdict: "fail", notes: v.notes };
  }
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/escalation.test.ts`
Expected: PASS (tierOf + 7 escalation testi).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil (E3a dahil), typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/escalation.ts test/engine/escalation.test.ts
git commit -m "feat: runTaskWithEscalation (tier merdiveni + askHuman seam)"
```

---

### Task 4: Üst tasarım dokümanı güncellemesi (senior-designer + §5.4 + §12)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-horse-code-multi-agent-orchestration-design.md`

**Interfaces:** Yok (yalnızca dokümantasyon). Kod değişmez.

- [ ] **Step 1: Rol tablosuna senior-designer ekle**

`senior-coder` satırından sonra ekle:

```markdown
| **senior-designer** | designer N tur takılınca devralır (daha güçlü model) |
```

Ve rol sayısını **13 → 14** güncelle (§ başındaki "13 adlandırılmış role" ifadesi).

- [ ] **Step 2: Config örneğine senior-designer ekle**

`"senior-coder"` config satırından sonra:

```json
    "senior-designer": { "models": ["auto/best-coding"], "skills": ["tdd"] },
```

- [ ] **Step 3: §5.4'ü güncelle (aileler + konsey semantiği + insana-sor)**

§5.4 merdiven bloğunu iki simetrik aile + konsey semantiği yansıtacak şekilde güncelle:

```markdown
coder    ──(N tur)──► senior-coder     ──(N tur)──►┐
designer ──(N tur)──► senior-designer  ──(N tur)──►┴► ESCALATION KONSEYİ
   { architect (kök-neden + plan) + senior (implement) + code-reviewer (son review) }
   → geçer: DONE (bağlayıcı) / kalır: insana sor (accept / retry / abandon)
```

Ve şu notu ekle: konsey `askHuman` seam'iyle insana çıkar (task-seviyesinde insan-in-loop yalnızca
konsey tükendiğinde; normal review'da code-reviewer nihai). `N` = tier başına tur (config
`escalation.rounds`, varsayılan 3).

- [ ] **Step 4: §12 açık noktalarını kapat**

"Escalation konseyi çıktısı" maddesini: "**Kararlaştırıldı (E3b):** architect diagnoz + senior
implement + son review; geçer→DONE, kalır→insana sor (accept/retry/abandon)." olarak güncelle.
"`N`" maddesine: "**Kararlaştırıldı (E3b):** tier başına `N` (config `escalation.rounds`, vars. 3);
config okuma E4'te wire edilir." ekle.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-20-horse-code-multi-agent-orchestration-design.md
git commit -m "docs: senior-designer + §5.4 escalation semantiği + §12 kapatma (E3b)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 tier hesabı → Task 3 `tierOf`; §3.1 runCycleWithRole → Task 1; §3.2 konsey → Task 2; §3.3 runTaskWithEscalation + askHuman → Task 3; §6 üst-doküman → Task 4. Tümü karşılandı.
- **Type consistency:** `RunnableRole` (Task 1) → implementer/council/escalation'da tutarlı; `EscalationDeps`/`HumanDecision`/`AskHuman` (Task 3) tek yerde; `ArchitectPlanSchema` (Task 2) yalnızca konseyde.
- **E3a koruması:** `runTaskCycle` imzası değişmedi; mevcut 5 test + yeni runCycleWithRole testi Task 1'de birlikte yeşil.
- **Abort:** escalation döngüsünde try/catch yok → alt katman (routeTask/runToCompletion/runStructuredRole) throw'u propagate eder.
