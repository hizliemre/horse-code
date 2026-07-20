# Dilim F1 — Refiner + Intent Routing + Coach Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upstream pipeline'ın girişini kurmak: `runRefiner` (prompt → {refinedPrompt, intent}) + `routeIntent` (deterministik chat|pipeline) + `runCoachChat` (salt-okunur repo tool'larıyla tek prompt yanıtı).

**Architecture:** `src/engine/refiner.ts` = refiner (structured output) + saf route fonksiyonu. `src/engine/coach.ts` = coach chat (`readOnlyRegistry` + `runToCompletion`). Mevcut `TaskCycleDeps`/`runStructuredRole`/`runToCompletion`/`readOnlyRegistry` yeniden kullanılır; yeni config/deps yüzeyi yok.

**Tech Stack:** TypeScript ESM, zod, vitest, MockProvider.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; ağ YOK (`MockProvider`).
- **Abort yutulmaz:** `runStructuredRole`/`runToCompletion` abort'ta throw eder; F1 birimleri bunu propagate eder.
- **E-skills coupling:** rol çalıştırılırken `resolve` (skill enjeksiyonlu) VE toolset'te `buildSkillTool` birlikte.
- **Coach salt-okunur:** `readOnlyRegistry` (read/grep/glob + skill) — write/edit/shell YOK.
- **Deps:** `TaskCycleDeps` reuse (`{provider, roleRegistry, skillRegistry, permission, approve, signal}`); config şeması değişmez.

---

### Task 1: `runRefiner` + `routeIntent` (refiner.ts)

**Files:**
- Create: `src/engine/refiner.ts`
- Test: `test/engine/refiner.test.ts`

**Interfaces:**
- Consumes: E0 `runStructuredRole`; C `RoleAgentOptions`; B2 `ToolRegistry`; E-skills `buildSkillTool`; `TaskCycleDeps`; zod.
- Produces:
  - `type Intent = "chat" | "feature" | "bugfix"`
  - `interface RefinerOutput { refinedPrompt: string; intent: Intent }`
  - `const RefinerSchema` (zod)
  - `runRefiner(deps: TaskCycleDeps, prompt: string): Promise<RefinerOutput>`
  - `routeIntent(intent: Intent): "chat" | "pipeline"`

- [ ] **Step 1: Kırmızı test**

`test/engine/refiner.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { runRefiner, routeIntent } from "../../src/engine/refiner.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
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
function deps(provider: MockProvider, skillRegistry = new SkillRegistry(), signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = { refiner: { models: ["m"], systemPrompt: "refine et" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, skillRegistry),
    skillRegistry,
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
  };
}

describe("routeIntent", () => {
  it("chat → chat; feature/bugfix → pipeline", () => {
    expect(routeIntent("chat")).toBe("chat");
    expect(routeIntent("feature")).toBe("pipeline");
    expect(routeIntent("bugfix")).toBe("pipeline");
  });
});

describe("runRefiner", () => {
  it("prompt'u refine eder + intent üretir", async () => {
    const p = new MockProvider([submit('{"refinedPrompt":"X yap","intent":"feature"}')]);
    const out = await runRefiner(deps(p), "x yapabilir misin");
    expect(out.intent).toBe("feature");
    expect(out.refinedPrompt).toBe("X yap");
  });

  it("skill listing eklendiyse skill tool toolset'te (E-skills coupling)", async () => {
    const sr = new SkillRegistry();
    sr.register({ name: "tdd", description: "TDD", content: "TDD içeriği" });
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await runRefiner(deps(p, sr), "x");
    expect(p.requests[0].tools.map((t) => t.name)).toContain("skill");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await expect(runRefiner(deps(p, new SkillRegistry(), ac.signal), "x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/refiner.test.ts`
Expected: FAIL — `refiner.js` yok.

- [ ] **Step 3: refiner.ts implement**

`src/engine/refiner.ts` oluştur:

```typescript
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps } from "./task-types.js";

export type Intent = "chat" | "feature" | "bugfix";
export interface RefinerOutput {
  refinedPrompt: string;
  intent: Intent;
}
export const RefinerSchema = z.object({
  refinedPrompt: z.string(),
  intent: z.enum(["chat", "feature", "bugfix"]),
});

/** Kullanıcı prompt'unu refine eder + intent sınıflandırır (structured, repo tool'u yok). */
export async function runRefiner(deps: TaskCycleDeps, prompt: string): Promise<RefinerOutput> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("refiner");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools,
    messages: [{ role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
  };
  return runStructuredRole(opts, RefinerSchema);
}

/** Deterministik intent route: chat → coach; feature/bugfix → upstream pipeline. */
export function routeIntent(intent: Intent): "chat" | "pipeline" {
  return intent === "chat" ? "chat" : "pipeline";
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/refiner.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/refiner.ts test/engine/refiner.test.ts
git commit -m "feat: runRefiner (structured {refinedPrompt, intent}) + routeIntent"
```

---

### Task 2: `runCoachChat` (coach.ts)

**Files:**
- Create: `src/engine/coach.ts`
- Test: `test/engine/coach.test.ts`

**Interfaces:**
- Consumes: C `runToCompletion`/`RoleAgentOptions`; E3a `readOnlyRegistry`; `TaskCycleDeps`.
- Produces: `runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string): Promise<string>` — coach'un final metin cevabı.

- [ ] **Step 1: Kırmızı test**

`test/engine/coach.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoachChat } from "../../src/engine/coach.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-coach-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const textTurn = (t: string): ChatEvent[] => [{ type: "text-delta", text: t }, { type: "done", finishReason: "stop" }];
function readTurn(path: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "r", name: "read_file", arguments: JSON.stringify({ path }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function deps(provider: MockProvider, signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = { coach: { models: ["m"], systemPrompt: "coach ol" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
  };
}

describe("runCoachChat", () => {
  it("tek-tur: prompt'u yanıtlar", async () => {
    const p = new MockProvider([textTurn("cevabım")]);
    expect(await runCoachChat(deps(p), "merhaba", dir)).toBe("cevabım");
  });

  it("salt-okunur tool'larla okuyup cevaplar; write/shell toolset'te yok", async () => {
    await writeFile(join(dir, "a.txt"), "içerik", "utf8");
    const p = new MockProvider([readTurn("a.txt"), textTurn("okudum ve cevaplıyorum")]);
    const out = await runCoachChat(deps(p), "a.txt nedir", dir);
    expect(out).toBe("okudum ve cevaplıyorum");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([textTurn("x")]);
    await expect(runCoachChat(deps(p, ac.signal), "x", dir)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/coach.test.ts`
Expected: FAIL — `coach.js` yok.

- [ ] **Step 3: coach.ts implement**

`src/engine/coach.ts` oluştur:

```typescript
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

/** Coach chat: salt-okunur repo tool'larıyla (read/grep/glob + skill) tek prompt'u yanıtlar; final metni döner. */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/coach.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/coach.ts test/engine/coach.test.ts
git commit -m "feat: runCoachChat (salt-okunur repo tool'ları + runToCompletion .content)"
```

---

## Self-Review Notu

- **Spec coverage:** §3.1 runRefiner + RefinerSchema/Output/Intent → Task 1; §3.2 routeIntent → Task 1; §3.3 runCoachChat → Task 2; §4 testler → her iki task. Tümü karşılandı.
- **Type consistency:** `RefinerSchema` zod tipi `RefinerOutput`'la eşleşir (`z.enum` → `Intent`); `runCoachChat` `Message.content` (string) döner; her ikisi `TaskCycleDeps` alır.
- **E-skills coupling:** refiner (`buildSkillTool`) + coach (`readOnlyRegistry` skill içerir) — resolve+skill-tool birlikte; testlerde `skill` toolset'te doğrulanır.
- **Abort:** her iki birim de `runStructuredRole`/`runToCompletion` throw'unu propagate eder; pre-aborted testleri rejection'ı doğrular.
