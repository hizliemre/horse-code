# horse-code Dilim E3a — Task Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bir task'ın tek-tur yaşam döngüsünü inşa etmek — `routeTask` (coder/designer), `runImplementer` (worktree'de kod yazar), `runReviewer` (structured verdikt), ve `runTaskCycle` (route→implement→review→Board geçişleri); MockProvider + tmp worktree ile headless test edilebilir.

**Architecture:** Dört saf/kompoze birim (`src/engine/`). `routeTask` bir router role-agent'ıyla (E0 structured) task title'dan role seçer (coder fallback, abort propagate). `runImplementer` implementer role'ünü (C `runToCompletion`) worktree-scope'lu tool'lar (B2 createDefaultRegistry + `buildSkillTool`) + skill-enjeksiyonlu prompt + yeni-vs-dönen mesajıyla koşar. `runReviewer` salt-okunur tool'larla (read/grep/glob + skill) structured verdikt üretir. `runTaskCycle` bunları Board (E1) geçişleri/stageHistory ile kompoze eder. Commit/merge/escalation E4/E3b'ye ertelenir.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod`, `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **E-skills wiring:** bir role çalıştırılırken `RoleRegistry.resolve` (skillRegistry ile) VE toolset'e `buildSkillTool(skillRegistry)` **birlikte** eklenir.
- **Abort propagate:** `routeTask` başarısızlıkta coder'a düşer AMA `signal.aborted` ise hatayı fırlatır (iptal yutulmaz).
- **reviewNotes:** fail'de **clear + set** (son turun notları); tam geçmiş stageHistory'de.
- **Commit yok:** E3a implement + review + Board geçişleri; git commit + wave-merge + PR → E4. Reviewer commit'siz worktree'yi read-tool'larla okur.
- **Reviewer salt-okunur:** read/grep/glob + skill (write/edit/shell YOK).
- Tüketilen mevcut: `runToCompletion`/`RoleAgentOptions` (`src/agent/loop.js`), `runStructuredRole` (`src/agent/structured.js`), `Board`/`Card` (`src/board/board.js`), `RoleRegistry` (`src/agent/roles.js`), `SkillRegistry` (`src/skills/registry.js`), `buildSkillTool` (`src/skills/apply.js`), `createDefaultRegistry`/`ToolRegistry` (`src/tools/index.js`,`src/tools/registry.js`), `readFileTool`/`grepTool`/`globTool` (`src/tools/{read,grep,glob}.js`), `MockProvider` (`src/providers/mock.js`), `PermissionEngine`/`PermissionRequest` (`src/permission/engine.js`), `Provider` (`src/core/types.js`), `zod`.
- Test framework `vitest`; her task TDD (önce başarısız test). fs testleri `mkdtemp` tmp dizinde.

---

### Task 1: Ortak Tipler + routeTask

**Files:**
- Create: `src/engine/task-types.ts`
- Create: `src/engine/routing.ts`
- Test: `test/engine/routing.test.ts`

**Interfaces:**
- Consumes: `Provider` (`src/core/types.js`), `PermissionEngine`/`PermissionRequest` (`src/permission/engine.js`), `RoleRegistry` (`src/agent/roles.js`), `SkillRegistry` (`src/skills/registry.js`), `Card` (`src/board/board.js`), `runStructuredRole` (`src/agent/structured.js`), `ToolRegistry` (`src/tools/registry.js`), `zod`
- Produces:
  - `task-types.ts`: `interface TaskCycleDeps`, `type ImplementerRole = "coder"|"designer"`, `interface Verdict { verdict:"pass"|"fail"; notes:string[] }`.
  - `routing.ts`: `routeTask(deps: TaskCycleDeps, task: Card): Promise<ImplementerRole>` — router role-agent; başarısız → "coder" fallback; `signal.aborted` → fırlatır.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/routing.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { routeTask } from "../../src/engine/routing.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const card = (title: string): Card => ({
  id: "t1", title, column: "TODO", deps: [], reviewNotes: [], attempts: 0, stageHistory: [],
});
function deps(provider: MockProvider, hasRouter = true, signal?: AbortSignal): TaskCycleDeps {
  const roles = hasRouter ? { router: { models: ["m"], systemPrompt: "route et" } } : {};
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
  };
}

describe("routeTask", () => {
  it("router 'designer' derse designer döner", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p), card("buton tasarımı"))).toBe("designer");
  });
  it("router submit üretmezse coder fallback", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "?" }, { type: "done", finishReason: "stop" }]]);
    expect(await routeTask(deps(p), card("x"))).toBe("coder");
  });
  it("router role tanımsızsa coder fallback", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p, false), card("x"))).toBe("coder");
  });
  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"role":"coder"}')]);
    await expect(routeTask(deps(p, true, ac.signal), card("x"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/routing.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/task-types.ts` yaz**

```typescript
import type { Provider } from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { RoleRegistry } from "../agent/roles.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface TaskCycleDeps {
  provider: Provider;
  roleRegistry: RoleRegistry;
  skillRegistry: SkillRegistry;
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
}

export type ImplementerRole = "coder" | "designer";

export interface Verdict {
  verdict: "pass" | "fail";
  notes: string[];
}
```

- [ ] **Step 4: `src/engine/routing.ts` yaz**

```typescript
import { z } from "zod";
import type { Card } from "../board/board.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import type { TaskCycleDeps, ImplementerRole } from "./task-types.js";

const RouteSchema = z.object({ role: z.enum(["coder", "designer"]) });

/** Task title'dan implementer role seçer. Başarısız → "coder"; signal.aborted → fırlatır. */
export async function routeTask(deps: TaskCycleDeps, task: Card): Promise<ImplementerRole> {
  try {
    const { model, systemPrompt } = deps.roleRegistry.resolve("router");
    const opts: RoleAgentOptions = {
      provider: deps.provider,
      model,
      systemPrompt,
      tools: new ToolRegistry(),
      messages: [
        { role: "user", content: `Task: "${task.title}". UI/UX işi mi (designer) yoksa kod işi mi (coder)?` },
      ],
      permission: deps.permission,
      approve: deps.approve,
      cwd: "/",
      signal: deps.signal,
    };
    const { role } = await runStructuredRole(opts, RouteSchema);
    return role;
  } catch (e) {
    if (deps.signal.aborted) throw e;
    return "coder";
  }
}
```

- [ ] **Step 5: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/engine/routing.test.ts && npm run typecheck`
Expected: PASS (4 test); hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/engine/task-types.ts src/engine/routing.ts test/engine/routing.test.ts
git commit -m "feat: task-cycle tipleri + routeTask (coder/designer router, coder fallback)"
```

---

### Task 2: runImplementer

**Files:**
- Create: `src/engine/implementer.ts`
- Test: `test/engine/implementer.test.ts`

**Interfaces:**
- Consumes: `Card` (`src/board/board.js`), `runToCompletion`/`RoleAgentOptions` (`src/agent/loop.js`), `createDefaultRegistry` (`src/tools/index.js`), `buildSkillTool` (`src/skills/apply.js`), `TaskCycleDeps`/`ImplementerRole` (`./task-types.js`)
- Produces:
  - `runImplementer(deps, role: ImplementerRole, task: Card, cwd: string): Promise<void>` — implementer role'ünü worktree-scope'lu tool'lar (createDefaultRegistry + skill tool) + yeni-vs-dönen mesajıyla `runToCompletion` ile koşar (cwd = worktree).

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/implementer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImplementer } from "../../src/engine/implementer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card, Board } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-impl-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ coder: { models: ["m"], systemPrompt: "sen coder'sın" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
const card = (over: Partial<Card> = {}): Card => ({
  id: "t1", title: "dosya yaz", column: "IN-PROGRESS", deps: [], reviewNotes: [], attempts: 0, stageHistory: [], ...over,
});
function writeThenDone(): ChatEvent[][] {
  return [
    [
      { type: "tool-call", toolCall: { id: "w1", name: "write_file", arguments: '{"path":"out.txt","content":"merhaba"}' } },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }],
  ];
}

describe("runImplementer", () => {
  it("implementer worktree'ye dosya yazar (cwd = worktree)", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card(), dir);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("merhaba");
  });

  it("dönen task'ta mesaj reviewNotes'u içerir", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }]]);
    await runImplementer(deps(p), "coder", card({ reviewNotes: ["testi düzelt"] }), dir);
    const msg = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(msg).toContain("DÖNEN");
    expect(msg).toContain("testi düzelt");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/implementer.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/implementer.ts` yaz**

```typescript
import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, ImplementerRole } from "./task-types.js";

/** Implementer role'ünü worktree-scope'lu tool'lar + yeni-vs-dönen mesajıyla çalıştırır. */
export async function runImplementer(
  deps: TaskCycleDeps,
  role: ImplementerRole,
  task: Card,
  cwd: string,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve(role);
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));

  const returning = task.reviewNotes.length > 0;
  const content = returning
    ? `Bu bir DÖNEN task: "${task.title}". Reviewer notlarını gider:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `Bu YENİ bir task: "${task.title}". Uygula.`;

  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools,
    messages: [{ role: "user", content }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  await runToCompletion(opts);
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/engine/implementer.test.ts && npm run typecheck`
Expected: PASS (2 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/implementer.ts test/engine/implementer.test.ts
git commit -m "feat: runImplementer (worktree-scope'lu tool'lar + skill + yeni-vs-dönen)"
```

---

### Task 3: runReviewer

**Files:**
- Create: `src/engine/reviewer.ts`
- Test: `test/engine/reviewer.test.ts`

**Interfaces:**
- Consumes: `Card` (`src/board/board.js`), `runStructuredRole`/`RoleAgentOptions` (`src/agent/*`), `ToolRegistry` (`src/tools/registry.js`), `readFileTool`/`grepTool`/`globTool` (`src/tools/{read,grep,glob}.js`), `buildSkillTool` (`src/skills/apply.js`), `TaskCycleDeps`/`Verdict` (`./task-types.js`), `zod`
- Produces:
  - `VerdictSchema` — `{ verdict: "pass"|"fail"; notes: string[] }`.
  - `runReviewer(deps, task: Card, cwd: string): Promise<Verdict>` — **salt-okunur** toolset (read/grep/glob + skill) ile structured verdikt.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/reviewer.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { runReviewer } from "../../src/engine/reviewer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const card = (): Card => ({ id: "t1", title: "X", column: "REVIEW", deps: [], reviewNotes: [], attempts: 0, stageHistory: [] });
function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ "code-reviewer": { models: ["m"], systemPrompt: "sen reviewer'sın" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}

describe("runReviewer", () => {
  it("structured verdikt döner", async () => {
    const p = new MockProvider([submitTurn('{"verdict":"fail","notes":["hata var"]}')]);
    expect(await runReviewer(deps(p), card(), "/tmp")).toEqual({ verdict: "fail", notes: ["hata var"] });
  });

  it("toolset salt-okunur (write/edit/shell içermez)", async () => {
    const p = new MockProvider([submitTurn('{"verdict":"pass","notes":[]}')]);
    await runReviewer(deps(p), card(), "/tmp");
    const toolNames = p.requests[0].tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");
    expect(toolNames).not.toContain("shell");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/reviewer.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/reviewer.ts` yaz**

```typescript
import { z } from "zod";
import type { Card } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

export const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  notes: z.array(z.string()),
});

/** Reviewer'ın salt-okunur toolset'i: read/grep/glob + skill (write/edit/shell YOK). */
function readOnlyRegistry(deps: TaskCycleDeps): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  return r;
}

/** code-reviewer role'ünü salt-okunur tool'larla koşup structured verdikt döner. */
export async function runReviewer(deps: TaskCycleDeps, task: Card, cwd: string): Promise<Verdict> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("code-reviewer");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [
      { role: "user", content: `Task "${task.title}" için worktree'deki değişiklikleri incele; verdikt ver (pass/fail + notlar).` },
    ],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  return runStructuredRole(opts, VerdictSchema);
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/engine/reviewer.test.ts && npm run typecheck`
Expected: PASS (2 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/reviewer.ts test/engine/reviewer.test.ts
git commit -m "feat: runReviewer (salt-okunur tool'lar + structured verdikt)"
```

---

### Task 4: runTaskCycle

**Files:**
- Create: `src/engine/task-cycle.ts`
- Test: `test/engine/task-cycle.test.ts`

**Interfaces:**
- Consumes: `Board`/`Card` (`src/board/board.js`), `routeTask` (`./routing.js`), `runImplementer` (`./implementer.js`), `runReviewer` (`./reviewer.js`), `TaskCycleDeps`/`Verdict` (`./task-types.js`)
- Produces:
  - `runTaskCycle(deps, board: Board, taskId: string, worktreePath: string): Promise<Verdict>` — route → IN-PROGRESS → implement → REVIEW → review → pass:DONE / fail:TODO+notlar; Board geçişleri + stageHistory; verdikt döner.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/task-cycle.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskCycle } from "../../src/engine/task-cycle.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-cycle-")); });
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
  const roles = {
    router: { models: ["m"], systemPrompt: "route" },
    coder: { models: ["m"], systemPrompt: "coder" },
    "code-reviewer": { models: ["m"], systemPrompt: "reviewer" },
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

describe("runTaskCycle", () => {
  it("pass: implement → review → DONE, dosya yazılı, worktree + stage kaydı", async () => {
    // router(coder) → implementer(write, done) → reviewer(pass)
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    expect(c.column).toBe("DONE");
    expect(c.worktree).toBe(dir);
    expect(c.stageHistory.some((s) => s.action === "reviewed:pass")).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("kod");
  });

  it("fail: TODO'ya döner, reviewNotes = notlar, reviewed:fail stage'i", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["testsiz"]}')]);
    const board = boardWithTask();
    const v = await runTaskCycle(deps(p), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    const c = board.get("t1")!;
    expect(c.column).toBe("TODO");
    expect(c.reviewNotes).toEqual(["testsiz"]);
    expect(c.stageHistory.some((s) => s.action === "reviewed:fail")).toBe(true);
  });

  it("bilinmeyen task → hata", async () => {
    const p = new MockProvider([]);
    await expect(runTaskCycle(deps(p), boardWithTask(), "yok", dir)).rejects.toThrow(/bilinmeyen task/);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/task-cycle.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/task-cycle.ts` yaz**

```typescript
import type { Board } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runReviewer } from "./reviewer.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

/** Bir task'ın tek-tur yaşam döngüsü: route → implement → review → Board geçişleri. */
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
  board.move(taskId, "IN-PROGRESS", role);

  await runImplementer(deps, role, board.get(taskId)!, worktreePath);
  board.move(taskId, "REVIEW", role);

  const v = await runReviewer(deps, board.get(taskId)!, worktreePath);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
    board.move(taskId, "DONE", "code-reviewer");
  } else {
    board.appendStage(taskId, {
      role: "code-reviewer",
      action: "reviewed:fail",
      note: v.notes.join("; "),
    });
    board.clearReviewNotes(taskId);
    for (const n of v.notes) board.addReviewNote(taskId, n);
    board.move(taskId, "TODO", "code-reviewer");
  }
  return v;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/engine/task-cycle.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/task-cycle.ts test/engine/task-cycle.test.ts
git commit -m "feat: runTaskCycle (route→implement→review→Board geçişleri)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D + E0 + E-skills + E1 + E2 + E3a)
- [ ] `git log --oneline` — bu dilimde 4 commit

Bu dilim şunu teslim eder: `routeTask` + `runImplementer` + `runReviewer` + `runTaskCycle` — bir task'ın tek-tur yaşam döngüsü (route → izole worktree'de implement → salt-okunur review → Board geçişleri). Sonraki alt-dilim **E3b** bu döngüyü escalation merdiveniyle (coder→senior-coder→konsey, attempts) sarar; **E4** dalgaları yürütür (worktree oluşturma/merge/PR).

## Kapsam Dışı (bilinçli — sonraki alt-dilimler)

- Escalation merdiveni (coder N tur → senior-coder → konsey) → E3b.
- git commit + wave-merge + PR → E4.
- Worktree oluşturma (D) → E4 (E3a var olan yolu alır).
- Gerçek prompt içerikleri → F/G.
