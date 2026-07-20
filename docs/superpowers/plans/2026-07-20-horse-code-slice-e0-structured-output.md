# horse-code Dilim E0 — Structured Role Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-agent'ın şema-doğrulamalı yapılandırılmış çıktı üretmesini sağlamak — `buildSubmitTool(schema)` (sentetik "submit" tool + yakalayıcı kutu) ve `runStructuredRole(opts, schema)` (C `runRoleAgent`'ı bu tool'la sarar, geçerli submit'te doğrulanmış nesneyi döner). Kendini düzelten (geçersiz → retry), headless test edilebilir.

**Architecture:** Mekanizma A — sentetik submit tool. `buildSubmitTool` bir `Tool` (parametreleri = zod şeması) ve bir "kutu" yakalayıcı döner; tool'un `run`'ı args'ı `safeParse` ile doğrular (geçerli → kutuya yazar; geçersiz → `isError`, model düzeltir). `runStructuredRole` role'ün ToolRegistry'sine submit'i ekler, `runRoleAgent`'ı (C) sürer, kutu dolunca erken çıkar. Yalnızca C'yi kompoze eder; loop'a dokunmaz.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod`, `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **Mekanizma A (sentetik submit tool)** — response_format/native JSON mode KULLANILMAZ.
- **C'yi yeniden kullan:** `runStructuredRole`, C'nin `runRoleAgent`'ını (`src/agent/loop.js`) sarar; C loop'unu DEĞİŞTİRMEZ.
- `submit` tool: `name:"submit"`, `permissionLevel:"safe"`, `parameters` = verilen zod şeması. `run` args'ı `safeParse` eder: geçerli → yakala (kutu), `{content:"alındı", isError:false}`; geçersiz → yakalama yok, `{content:"submit: geçersiz çıktı: <issues>", isError:true}`.
- **Kutu (`{value:T}|undefined`) kullan** — `T` falsy olabilir; varlık kontrolü kutuyla yapılır, `!== undefined` değerle değil.
- `schema` bir zod **objesi** olmalı (tool parametreleri nesne bekler) — kullanım bunu varsayar.
- Tüketilen mevcut: `Tool`/`ToolResult`/`ToolContext` (`src/core/types.js`), `ToolRegistry` (`src/tools/registry.js`), `runRoleAgent`/`RoleAgentOptions` (`src/agent/loop.js`), `MockProvider` (`src/providers/mock.js`), `PermissionEngine` (`src/permission/engine.js`).
- Test framework `vitest`; her task TDD (önce başarısız test).

---

### Task 1: buildSubmitTool

**Files:**
- Create: `src/agent/structured.ts`
- Test: `test/agent/submit-tool.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`), `z.ZodType` (`zod`, type-only)
- Produces:
  - `interface SubmitToolHandle<T> { tool: Tool; result(): { value: T } | undefined }`
  - `buildSubmitTool<T>(schema: z.ZodType<T>): SubmitToolHandle<T>` — safe "submit" tool + yakalayıcı kutu.

- [ ] **Step 1: Başarısız testi yaz**

`test/agent/submit-tool.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSubmitTool } from "../../src/agent/structured.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });
const schema = z.object({ decision: z.enum(["pass", "fail"]) });

describe("buildSubmitTool", () => {
  it("geçerli args'ı yakalar (isError:false)", async () => {
    const h = buildSubmitTool(schema);
    const res = await h.tool.run({ decision: "pass" }, ctx());
    expect(res.isError).toBe(false);
    expect(h.result()).toEqual({ value: { decision: "pass" } });
  });

  it("geçersiz args'ı yakalamaz (isError:true, kutu boş)", async () => {
    const h = buildSubmitTool(schema);
    const res = await h.tool.run({ decision: "bogus" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("geçersiz");
    expect(h.result()).toBeUndefined();
  });

  it("tool metadata doğru (name/safe/parameters)", () => {
    const h = buildSubmitTool(schema);
    expect(h.tool.name).toBe("submit");
    expect(h.tool.permissionLevel).toBe("safe");
    expect(h.tool.parameters).toBe(schema);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/submit-tool.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/agent/structured.ts` yaz**

```typescript
import type { z } from "zod";
import type { Tool } from "../core/types.js";

export interface SubmitToolHandle<T> {
  tool: Tool;
  result(): { value: T } | undefined;
}

/**
 * Parametreleri = verilen zod şeması olan bir "submit" tool'u ve yakalayıcı kutu döner.
 * Model submit'i çağırınca args doğrulanır; geçerliyse kutuya yazılır, geçersizse isError döner.
 */
export function buildSubmitTool<T>(schema: z.ZodType<T>): SubmitToolHandle<T> {
  let box: { value: T } | undefined;
  const tool: Tool = {
    name: "submit",
    description: "İşin bittiğinde sonucunu bu araçla yapılandırılmış olarak gönder.",
    permissionLevel: "safe",
    parameters: schema,
    run: async (rawArgs) => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: `submit: geçersiz çıktı: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        };
      }
      box = { value: parsed.data };
      return { content: "alındı", isError: false };
    },
  };
  return { tool, result: () => box };
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/agent/submit-tool.test.ts && npm run typecheck`
Expected: PASS (3 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/agent/structured.ts test/agent/submit-tool.test.ts
git commit -m "feat: buildSubmitTool (sentetik submit tool + yakalayıcı kutu)"
```

---

### Task 2: runStructuredRole

**Files:**
- Modify: `src/agent/structured.ts` (`runStructuredRole` + import'lar)
- Test: `test/agent/structured.test.ts`

**Interfaces:**
- Consumes: `buildSubmitTool` (Task 1); `runRoleAgent`/`RoleAgentOptions` (`src/agent/loop.js`); `ToolRegistry` (`src/tools/registry.js`)
- Produces:
  - `runStructuredRole<T>(opts: RoleAgentOptions, schema: z.ZodType<T>): Promise<T>` — submit'i role'ün registry'sine ekler, `runRoleAgent`'ı sürer; geçerli submit yakalanınca erken çıkar ve nesneyi döner. `error` event → throw; submit hiç gelmezse → throw.

- [ ] **Step 1: Başarısız testi yaz**

`test/agent/structured.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runStructuredRole } from "../../src/agent/structured.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

const schema = z.object({ decision: z.enum(["pass", "fail"]) });

function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen bir reviewer'sın",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "incele" }],
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

describe("runStructuredRole", () => {
  it("geçerli submit'i parse edip döner; istekte submit tool'u bulunur", async () => {
    const p = new MockProvider([submitTurn('{"decision":"pass"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "pass" });
    expect(p.requests[0].tools.map((t) => t.name)).toContain("submit");
    expect(p.requests).toHaveLength(1); // geçerli submit → erken çıkış, fazladan turn yok
  });

  it("geçersiz submit sonrası geçerli submit → doğru sonuç (2 istek)", async () => {
    const p = new MockProvider([submitTurn('{"decision":"bogus"}'), submitTurn('{"decision":"fail"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "fail" });
    expect(p.requests).toHaveLength(2);
  });

  it("submit çağrılmazsa hata verir", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow(/submit çağrılmadı/);
  });

  it("provider error → hata verir", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/structured.test.ts`
Expected: FAIL — `runStructuredRole` yok.

- [ ] **Step 3: `src/agent/structured.ts`'e ekle**

Dosyanın başındaki import'lara ekle (mevcut `import type` satırlarının altına):
```typescript
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";
```

Dosyanın SONUNA (buildSubmitTool'dan sonra) ekle:
```typescript
/**
 * Bir role'ü yapılandırılmış çıktı üretecek şekilde koşar: submit tool'unu role'ün
 * registry'sine ekler, runRoleAgent'ı sürer, geçerli submit yakalanınca doğrulanmış nesneyi döner.
 */
export async function runStructuredRole<T>(
  opts: RoleAgentOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const handle = buildSubmitTool(schema);
  const registry = new ToolRegistry();
  for (const t of opts.tools.list()) registry.register(t);
  registry.register(handle.tool);

  for await (const ev of runRoleAgent({ ...opts, tools: registry })) {
    if (ev.type === "error") throw new Error(ev.message);
    if (handle.result() !== undefined) break; // geçerli submit yakalandı → erken çık
  }

  const r = handle.result();
  if (r === undefined) throw new Error("structured role: submit çağrılmadı");
  return r.value;
}
```

> Not: `import type { z }` (Task 1) tip-only kalır; `runRoleAgent`/`ToolRegistry` değer import'u. `submit` safe olduğundan executeToolCalls'da otomatik/paralel çalışır; kutu dolunca `break` provider'a fazladan turn atmadan çıkar.

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/agent/structured.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/agent/structured.ts test/agent/structured.test.ts
git commit -m "feat: runStructuredRole (C loop'unu submit tool'la sarar, yapılandırılmış çıktı)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D + E1 + E0)
- [ ] `git log --oneline` — bu dilimde 2 commit

Bu dilim şunu teslim eder: `buildSubmitTool` + `runStructuredRole` — role-agent'ların şema-doğrulamalı yapılandırılmış çıktı üretmesi. **E2** (project-manager task listesi, team-lead dalgaları), **E3** (code-reviewer verdikti) ve **F** (refiner/judge) bunu `RoleRegistry.resolve` ile kompoze ederek tüketir.

## Kapsam Dışı (bilinçli — sonraki alt-dilimler)

- Role çözümü (RoleRegistry.resolve + runStructuredRole kompozisyonu) → E2/F çağıranı.
- submit çağrılmadığında nudge-retry (E0: doğrudan hata) → gerekirse ileride.
- Skill enjeksiyonu → E-skills.
- response_format / native JSON mode → kullanılmaz (mekanizma A).
