# horse-code Dilim E2 — project-manager + team-lead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Planı çalıştırılabilir board'a çeviren iki orkestrasyon parçasını inşa etmek — deterministik dalga hesabı (`computeWaves`/`validateWaves`), `runProjectManager` (plan → task kartlı Board, dep-bütünlüğü self-correct), ve hibrit `runTeamLead` (deterministik dalgalar + LLM teyit, geçersizde deterministik fallback); headless test edilebilir.

**Architecture:** `computeWaves` saf topolojik katmanlama; `validateWaves` saf doğrulayıcı. `runProjectManager` E0 `runStructuredRole`'ü `TasksSchema` (`.superRefine` ile dep-bütünlüğü) ile koşup E1 `Board` kurar — geçersiz graf submit-retry ile düzeltilir. `runTeamLead` `computeWaves`'i taban alıp team-lead LLM'iyle teyit eder; LLM çıktısı `validateWaves`'ten geçerse onu, değilse deterministik tabanı kullanır. Yeni `src/engine/` dizini.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod`, `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **Dalga hesabı deterministik:** `computeWaves` topolojik katmanlama (Kahn); LLM YOK. Döngü/çözülemeyen dep → hata.
- **team-lead hibrit:** deterministik `suggested = computeWaves(board)` taban; LLM teyit eder; LLM çıktısı `validateWaves`'ten **geçmezse deterministik `suggested` kullanılır** (taban otorite).
- **project-manager self-correct:** `TasksSchema.superRefine` tekrarlı id + dangling dep'i yakalar → E0 submit `isError` → model düzeltir.
- **Routing yok:** task `{id, title, deps}` minimal; coder-vs-designer E3'te.
- Tüketilen mevcut: `runStructuredRole` (`src/agent/structured.js`), `Board`/`Card` (`src/board/board.js`), `RoleAgentOptions` (`src/agent/loop.js`), `MockProvider` (`src/providers/mock.js`), `ToolRegistry` (`src/tools/registry.js`), `PermissionEngine` (`src/permission/engine.js`), `zod`.
- Test framework `vitest`; her task TDD (önce başarısız test).

---

### Task 1: computeWaves + validateWaves

**Files:**
- Create: `src/engine/waves.ts`
- Test: `test/engine/waves.test.ts`

**Interfaces:**
- Consumes: `Board`, `Card` (`src/board/board.js`)
- Produces:
  - `computeWaves(board: Board): string[][]` — deps'e göre topolojik dalgalar (dalga içi = ekleme sırası); döngü/çözülemeyen dep → hata.
  - `validateWaves(waves: string[][], board: Board): boolean` — her kart tam bir kez + her task'ın deps'i önceki dalgalarda.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/waves.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { computeWaves, validateWaves } from "../../src/engine/waves.js";
import { Board } from "../../src/board/board.js";

function board(cards: { id: string; deps?: string[] }[]): Board {
  const b = new Board();
  for (const c of cards) b.addCard({ id: c.id, title: c.id, deps: c.deps });
  return b;
}

describe("computeWaves", () => {
  it("bağımsız kartlar aynı dalgada", () => {
    expect(computeWaves(board([{ id: "a" }, { id: "b" }]))).toEqual([["a", "b"]]);
  });
  it("zincir sıralı dalgalar", () => {
    const b = board([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
    expect(computeWaves(b)).toEqual([["a"], ["b"], ["c"]]);
  });
  it("elmas: a → {b,c} → d", () => {
    const b = board([
      { id: "a" },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ]);
    expect(computeWaves(b)).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("döngü → hata", () => {
    const b = board([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]);
    expect(() => computeWaves(b)).toThrow(/döngü|çözülemeyen/);
  });
  it("boş board → boş dalgalar", () => {
    expect(computeWaves(new Board())).toEqual([]);
  });
});

describe("validateWaves", () => {
  const chain = () => board([{ id: "a" }, { id: "b", deps: ["a"] }]);
  it("geçerli dalgalar → true", () => {
    expect(validateWaves([["a"], ["b"]], chain())).toBe(true);
  });
  it("dep aynı dalgada → false", () => {
    expect(validateWaves([["a", "b"]], chain())).toBe(false);
  });
  it("eksik/tekrar kart → false", () => {
    expect(validateWaves([["a"]], chain())).toBe(false); // b eksik
    expect(validateWaves([["a"], ["b"], ["a"]], chain())).toBe(false); // a tekrar
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/waves.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/waves.ts` yaz**

```typescript
import type { Board } from "../board/board.js";

/** Kartları deps'e göre topolojik dalgalara böler. Döngü/çözülemeyen dep → hata. */
export function computeWaves(board: Board): string[][] {
  const cards = board.list();
  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = cards;

  while (remaining.length) {
    const layer = remaining.filter((c) => c.deps.every((d) => placed.has(d)));
    if (layer.length === 0) {
      throw new Error("computeWaves: bağımlılık döngüsü veya çözülemeyen bağımlılık");
    }
    waves.push(layer.map((c) => c.id));
    for (const c of layer) placed.add(c.id);
    remaining = remaining.filter((c) => !placed.has(c.id));
  }
  return waves;
}

/** Dalgalar geçerli mi: her kart tam bir kez + her task'ın deps'i önceki dalgalarda. */
export function validateWaves(waves: string[][], board: Board): boolean {
  const cards = board.list();
  const allIds = new Set(cards.map((c) => c.id));
  const depsOf = new Map(cards.map((c) => [c.id, c.deps]));

  const flat = waves.flat();
  if (flat.length !== allIds.size) return false;
  const seen = new Set<string>();
  for (const id of flat) {
    if (!allIds.has(id) || seen.has(id)) return false;
    seen.add(id);
  }

  const before = new Set<string>();
  for (const wave of waves) {
    for (const id of wave) {
      const deps = depsOf.get(id) ?? [];
      if (!deps.every((d) => before.has(d))) return false;
    }
    for (const id of wave) before.add(id);
  }
  return true;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/engine/waves.test.ts && npm run typecheck`
Expected: PASS (tüm alt testler); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/waves.ts test/engine/waves.test.ts
git commit -m "feat: computeWaves (deterministik topo dalgalar) + validateWaves"
```

---

### Task 2: TasksSchema + runProjectManager

**Files:**
- Create: `src/engine/project-manager.ts`
- Test: `test/engine/project-manager.test.ts`

**Interfaces:**
- Consumes: `runStructuredRole` (`src/agent/structured.js`), `Board` (`src/board/board.js`), `RoleAgentOptions` (`src/agent/loop.js`), `zod`
- Produces:
  - `TasksSchema` — `{ tasks: {id, title, deps}[] }` + `.superRefine` (tekrarlı id / dangling dep → hata).
  - `runProjectManager(opts: RoleAgentOptions): Promise<Board>` — `runStructuredRole(opts, TasksSchema)` → task kartlı Board.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/project-manager.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { runProjectManager } from "../../src/engine/project-manager.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen project-manager'sın",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "plan: X ve Y yap" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };
}
function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("runProjectManager", () => {
  it("task'ları Board kartlarına dönüştürür", async () => {
    const p = new MockProvider([
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[]},{"id":"t2","title":"Y","deps":["t1"]}]}'),
    ]);
    const board = await runProjectManager(opts(p));
    expect(board.list().map((c) => ({ id: c.id, title: c.title, deps: c.deps, column: c.column }))).toEqual([
      { id: "t1", title: "X", deps: [], column: "TODO" },
      { id: "t2", title: "Y", deps: ["t1"], column: "TODO" },
    ]);
  });

  it("dangling dep → self-correct (superRefine isError → yeniden submit)", async () => {
    const p = new MockProvider([
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":["yok"]}]}'), // geçersiz
      submitTurn('{"tasks":[{"id":"t1","title":"X","deps":[]}]}'), // düzeltilmiş
    ]);
    const board = await runProjectManager(opts(p));
    expect(board.list().map((c) => c.id)).toEqual(["t1"]);
    expect(p.requests).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/project-manager.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/project-manager.ts` yaz**

```typescript
import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { Board } from "../board/board.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  deps: z.array(z.string()),
});

export const TasksSchema = z
  .object({ tasks: z.array(taskSchema) })
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (const t of val.tasks) {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", message: `tekrarlı task id: ${t.id}` });
      ids.add(t.id);
    }
    for (const t of val.tasks) {
      for (const d of t.deps) {
        if (!ids.has(d)) {
          ctx.addIssue({ code: "custom", message: `task ${t.id}: tanımsız bağımlılık: ${d}` });
        }
      }
    }
  });

/** Plan (opts.messages'te) → task kartlı bir Board. Dep-bütünlüğü submit-retry ile self-correct. */
export async function runProjectManager(opts: RoleAgentOptions): Promise<Board> {
  const { tasks } = await runStructuredRole(opts, TasksSchema);
  const board = new Board();
  for (const t of tasks) board.addCard({ id: t.id, title: t.title, deps: t.deps });
  return board;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/engine/project-manager.test.ts && npm run typecheck`
Expected: PASS (2 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/project-manager.ts test/engine/project-manager.test.ts
git commit -m "feat: runProjectManager (plan → task kartlı Board, dep-bütünlüğü self-correct)"
```

---

### Task 3: WavesSchema + runTeamLead

**Files:**
- Create: `src/engine/team-lead.ts`
- Test: `test/engine/team-lead.test.ts`

**Interfaces:**
- Consumes: `runStructuredRole` (`src/agent/structured.js`), `Board` (`src/board/board.js`), `RoleAgentOptions` (`src/agent/loop.js`), `computeWaves`/`validateWaves` (`./waves.js`), `zod`
- Produces:
  - `WavesSchema` — `{ waves: string[][] }` (yalnızca şekil).
  - `runTeamLead(opts: RoleAgentOptions, board: Board): Promise<string[][]>` — deterministik `computeWaves` taban; LLM teyit; LLM çıktısı `validateWaves`'ten geçerse onu, değilse (veya LLM hata/submit yoksa) deterministik tabanı döner.

- [ ] **Step 1: Başarısız testi yaz**

`test/engine/team-lead.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { runTeamLead } from "../../src/engine/team-lead.js";
import { Board } from "../../src/board/board.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

function chainBoard(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X" });
  b.addCard({ id: "t2", title: "Y", deps: ["t1"] });
  return b;
}
function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen team-lead'sin",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "dalgaları teyit et" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };
}
function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("runTeamLead", () => {
  it("LLM geçerli dalga döndürünce onu kullanır; istekte kartlar + öneri bulunur", async () => {
    const p = new MockProvider([submitTurn('{"waves":[["t1"],["t2"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
    const sent = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("t1");
    expect(sent).toContain("Deterministik önerilen dalgalar");
  });

  it("LLM geçersiz dalga döndürünce deterministik tabana düşer", async () => {
    // t2 önce, t1 sonra → t2'nin dep'i (t1) önceki dalgada değil → geçersiz
    const p = new MockProvider([submitTurn('{"waves":[["t2"],["t1"]]}')]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]); // deterministik suggested
  });

  it("LLM submit üretmezse deterministik tabana düşer", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hmm" }, { type: "done", finishReason: "stop" }]]);
    const waves = await runTeamLead(opts(p), chainBoard());
    expect(waves).toEqual([["t1"], ["t2"]]);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/engine/team-lead.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/engine/team-lead.ts` yaz**

```typescript
import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import { computeWaves, validateWaves } from "./waves.js";

export const WavesSchema = z.object({ waves: z.array(z.array(z.string())) });

/**
 * Deterministik dalgaları hesaplar, team-lead LLM'iyle teyit eder.
 * LLM çıktısı geçerliyse onu, değilse (veya hata/submit yoksa) deterministik tabanı döner.
 */
export async function runTeamLead(opts: RoleAgentOptions, board: Board): Promise<string[][]> {
  const suggested = computeWaves(board);

  const cardsDesc = board
    .list()
    .map((c) => `- ${c.id}: "${c.title}" deps=[${c.deps.join(", ")}]`)
    .join("\n");
  const teamLeadMsg = {
    role: "user" as const,
    content:
      `Kartlar:\n${cardsDesc}\n\nDeterministik önerilen dalgalar (id listeleri):\n` +
      `${JSON.stringify(suggested)}\n\nBu dalgaları teyit et; gerekiyorsa düzelt. ` +
      `Her task tam bir kez olmalı ve her dalgadaki task'ın bağımlılıkları önceki dalgalarda tamamlanmış olmalı.`,
  };

  let llmWaves: string[][];
  try {
    const out = await runStructuredRole(
      { ...opts, messages: [...opts.messages, teamLeadMsg] },
      WavesSchema,
    );
    llmWaves = out.waves;
  } catch {
    return suggested; // LLM submit üretmedi / hata → deterministik
  }

  return validateWaves(llmWaves, board) ? llmWaves : suggested;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/engine/team-lead.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/engine/team-lead.ts test/engine/team-lead.test.ts
git commit -m "feat: runTeamLead (deterministik dalgalar + LLM teyit, geçersizde fallback)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D + E0 + E-skills + E1 + E2)
- [ ] `git log --oneline` — bu dilimde 3 commit

Bu dilim şunu teslim eder: `computeWaves`/`validateWaves` (deterministik dalga), `runProjectManager` (plan → Board), `runTeamLead` (hibrit dalga teyidi). Sonraki alt-dilim **E3** bu Board'u ve dalgaları tüketerek her task için coder/designer'ı (izole worktree, D) koşturur, code-reviewer + escalation ekler; **E4** dalgaları gerçekten yürütür (wave-merge, PR).

## Kapsam Dışı (bilinçli — sonraki alt-dilimler)

- coder/designer/reviewer yürütme + escalation → E3.
- Dalga motoru (dalgaları çalıştırma, task worktree, wave-merge, PR) → E4.
- Gerçek PM/team-lead prompt içerikleri → F/G.
- coder-vs-designer routing → E3.
- Deterministik fallback'in audit event'i → ileride.
