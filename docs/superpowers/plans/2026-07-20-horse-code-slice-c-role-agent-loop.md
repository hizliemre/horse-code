# horse-code Dilim C — Role-agent İç Döngüsü Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `(model, systemPrompt, toolset)` ile parametrelenmiş yeniden kullanılabilir tool-calling role-agent döngüsünü (`runRoleAgent` + `runToCompletion`), permission-entegre tool çalıştırmayı (`executeToolCalls`), role-adı→model çözen `RoleRegistry`'yi (round-robin) ve testler için `MockProvider`'ı inşa etmek — hepsi headless, tam test edilebilir.

**Architecture:** Çekirdek loop `Provider.chat()` (B1) stream'ini tüketir, `ToolRegistry` (B2) ile tool şeması üretip tool çalıştırır, `PermissionEngine` (Foundation) ile onay verir, `AgentEvent` yayar. `executeToolCalls` ayrı bir birim: onaysız (allow) tool'ları paralel, onay gerektirenleri (ask) sıralı çalıştırır ve seam kontratlarını (describe throw, boş tool-call id) uygular. `RoleRegistry` config'ten role→model round-robin + prompt çözer. `MockProvider` scripted `ChatEvent` turn'leriyle deterministik test sağlar.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod` (config şeması), `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- Loop **UI-agnostik**: yalnızca `AgentEvent` yayar, doğrudan I/O yapmaz. Permission "ask" kararı **enjekte `approve` callback**'iyle alınır (headless test + Dilim H'de UI köprüsü).
- Provider **ince transport** (B1): retry/model-seçimi loop'ta YOK. Loop tek `model` alır.
- Tool `run` **asla throw etmez** (B2 sözleşmesi) → `Promise.all` reddi olmaz.
- **Round-robin deterministik:** `models[index++ % len]`, role başına sayaç. `Math.random` YOK.
- **Tool çalıştırma:** onaysız (`allow`) tool'lar **paralel** (`Promise.all`), onay gerektiren (`ask`) tool'lar **sıralı**; tool sonuçları **çağrı sırasıyla** history'e eklenir.
- **Seam kontratları:** `Tool.describe()` malformed args'ta throw edebilir → try/catch, hata result. Provider tool-call `id===""` taşıyabilir → çalıştırma yok, korele hata result. Bilinmeyen tool adı / bozuk JSON argüman → hata result. **Her tool-call bir tool-result üretir** (LLM mesaj yapısı tutarlı kalsın).
- Tüketilen mevcut tipler (`src/core/types.ts`, DEĞİŞTİRİLMEZ): `Provider`, `ChatRequest`, `ChatEvent`, `Message`, `AgentEvent`, `ToolCall`, `ToolResult`, `ToolContext`, `PermissionLevel`. Foundation: `PermissionEngine`, `PermissionRequest` (`src/permission/engine.js`). B2: `ToolRegistry`, `Tool` (`src/tools/registry.js`, `src/core/types.js`).
- Test framework `vitest`; her task TDD (önce başarısız test).

---

### Task 1: MockProvider (test double)

**Files:**
- Create: `src/providers/mock.ts`
- Test: `test/providers/mock.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`, `ChatRequest`, `Provider` (`src/core/types.js`)
- Produces: `class MockProvider implements Provider` — kurucu `(turns: ChatEvent[][])`; her `chat()` çağrısı sıradaki turn'ün event'lerini yayar (turn biterse varsayılan `done`); yapılan `chat` isteklerini `requests: ChatRequest[]` alanında biriktirir (gözlem/assert için).

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/mock.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (model: string): ChatRequest => ({ model, messages: [], tools: [] });

describe("MockProvider", () => {
  it("her chat çağrısında sıradaki turn'ü yayar ve istekleri kaydeder", async () => {
    const p = new MockProvider([
      [{ type: "text-delta", text: "a" }, { type: "done", finishReason: "stop" }],
      [{ type: "text-delta", text: "b" }, { type: "done", finishReason: "stop" }],
    ]);
    expect(await drain(p.chat(req("m1"), new AbortController().signal))).toEqual([
      { type: "text-delta", text: "a" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(await drain(p.chat(req("m2"), new AbortController().signal))).toEqual([
      { type: "text-delta", text: "b" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(p.requests.map((r) => r.model)).toEqual(["m1", "m2"]);
  });

  it("turn'ler bitince varsayılan done yayar", async () => {
    const p = new MockProvider([]);
    expect(await drain(p.chat(req("m"), new AbortController().signal))).toEqual([
      { type: "done", finishReason: "stop" },
    ]);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/providers/mock.test.ts`
Expected: FAIL — `Cannot find module '../../src/providers/mock.js'`.

- [ ] **Step 3: `src/providers/mock.ts` yaz**

```typescript
import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";

/**
 * Test double: her chat() çağrısı için önceden yazılmış bir ChatEvent turn'ü yayar.
 * Çok-turlu loop'ları (tool-call → tool sonucu → ikinci turn) deterministik test eder.
 */
export class MockProvider implements Provider {
  private index = 0;
  readonly requests: ChatRequest[] = [];

  constructor(private turns: ChatEvent[][]) {}

  async *chat(req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    const turn = this.turns[this.index] ?? [{ type: "done", finishReason: "stop" }];
    this.index++;
    for (const ev of turn) yield ev;
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/mock.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/providers/mock.ts test/providers/mock.test.ts
git commit -m "feat: MockProvider (scripted ChatEvent turn'leri, test double)"
```

---

### Task 2: executeToolCalls (permission + paralel/sıralı çalıştırma)

**Files:**
- Create: `src/agent/tool-exec.ts`
- Test: `test/agent/tool-exec.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `ToolCall`, `ToolResult`, `Tool` (`src/core/types.js`); `PermissionEngine`, `PermissionRequest` (`src/permission/engine.js`); `ToolRegistry` (`src/tools/registry.js`)
- Produces:
  - `interface ToolExecResult { id: string; name: string; result: ToolResult }`
  - `interface ToolExecDeps { tools: ToolRegistry; permission: PermissionEngine; approve: (req: PermissionRequest) => Promise<boolean>; cwd: string; signal: AbortSignal }`
  - `executeToolCalls(calls: ToolCall[], deps: ToolExecDeps): AsyncGenerator<AgentEvent, ToolExecResult[], void>` — `AgentEvent` yayar (`tool.request`/`permission.ask`/`tool.result`), **çağrı sırasında** `ToolExecResult[]` döner. `safe`→otomatik allow; write/exec→`describe()`+`check()`; allow'lar paralel, ask'ler sıralı (approve); seam kontratları hata result üretir.

- [ ] **Step 1: Başarısız testi yaz**

`test/agent/tool-exec.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls, type ToolExecResult } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, Tool, ToolCall } from "../../src/core/types.js";

// Basit sahte tool'lar
const safeEcho: Tool = {
  name: "echo",
  description: "girdiyi döner",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
const writeTool: Tool = {
  name: "w",
  description: "yazar",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: (a) => ({ allowKey: String(a.p), preview: `write ${a.p}` }),
  run: async (a) => ({ content: `wrote:${a.p}`, isError: false }),
};
const throwsDescribe: Tool = {
  name: "bad",
  description: "describe throw",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: () => { throw new Error("describe patladı"); },
  run: async () => ({ content: "x", isError: false }),
};

function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
function call(id: string, name: string, args: object): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
async function drainGen(
  gen: AsyncGenerator<AgentEvent, ToolExecResult[], void>,
): Promise<{ events: AgentEvent[]; result: ToolExecResult[] }> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}
const deps = (over: Partial<Parameters<typeof executeToolCalls>[1]>) => ({
  tools: registry(safeEcho, writeTool, throwsDescribe),
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
});

describe("executeToolCalls", () => {
  it("safe tool otomatik çalışır, sonuç çağrı sırasında döner", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "echo", { t: "hi" })], deps({})));
    expect(result).toEqual([{ id: "1", name: "echo", result: { content: "echo:hi", isError: false } }]);
  });

  it("auto modda write tool çalışır", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "w", { p: "a.ts" })], deps({})));
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("ask modda approve=false ise reddedilir (çalıştırılmaz)", async () => {
    const { events, result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => false,
      })),
    );
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("reddetti");
    expect(events.some((e) => e.type === "permission.ask")).toBe(true);
  });

  it("ask modda approve=true ise çalışır", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => true,
      })),
    );
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("bilinmeyen tool → hata result", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "yok", {})], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("bilinmeyen tool");
  });

  it("boş tool-call id → hata result (çalıştırılmaz)", async () => {
    const { result } = await drainGen(executeToolCalls([call("", "echo", { t: "x" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("geçersiz tool-call id");
  });

  it("describe throw → hata result (çalıştırılmaz)", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "bad", { p: "a" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("describe");
  });

  it("çoklu safe tool paralel çalışır, sonuç çağrı sırasında", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "echo", { t: "a" }), call("2", "echo", { t: "b" })], deps({})),
    );
    expect(result.map((r) => r.result.content)).toEqual(["echo:a", "echo:b"]);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/tool-exec.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/agent/tool-exec.ts` yaz**

```typescript
import type { AgentEvent, Tool, ToolCall, ToolResult } from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface ToolExecResult {
  id: string;
  name: string;
  result: ToolResult;
}

export interface ToolExecDeps {
  tools: ToolRegistry;
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
}

interface Plan {
  index: number;
  call: ToolCall;
  kind: "run" | "ask" | "error" | "deny";
  tool?: Tool;
  args?: Record<string, unknown>;
  req?: PermissionRequest;
  errorContent?: string;
}

function errResult(name: string, msg: string): ToolResult {
  return { content: `${name}: ${msg}`, isError: true };
}

/**
 * Tool-call'ları permission ile süzüp çalıştırır. allow'lar paralel, ask'ler sıralı.
 * AgentEvent yayar; sonuçları ÇAĞRI SIRASINDA döner (her call için bir result).
 */
export async function* executeToolCalls(
  calls: ToolCall[],
  deps: ToolExecDeps,
): AsyncGenerator<AgentEvent, ToolExecResult[], void> {
  const results: ToolExecResult[] = new Array(calls.length);
  const plans: Plan[] = [];

  // 1) Sınıflandır
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.id) {
      plans.push({ index: i, call, kind: "error", errorContent: "geçersiz tool-call id" });
      continue;
    }
    const tool = deps.tools.get(call.name);
    if (!tool) {
      plans.push({ index: i, call, kind: "error", errorContent: `bilinmeyen tool: ${call.name}` });
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      plans.push({ index: i, call, kind: "error", errorContent: "argümanlar geçersiz JSON" });
      continue;
    }
    if (tool.permissionLevel === "safe") {
      plans.push({ index: i, call, kind: "run", tool, args });
      continue;
    }
    let desc: { allowKey: string; preview: string };
    try {
      desc = tool.describe ? tool.describe(args) : { allowKey: call.name, preview: call.name };
    } catch (e) {
      plans.push({
        index: i, call, kind: "error",
        errorContent: `describe hatası: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const req: PermissionRequest = { level: tool.permissionLevel, preview: desc.preview, allowKey: desc.allowKey };
    const decision = deps.permission.check(req);
    plans.push({ index: i, call, kind: decision === "allow" ? "run" : decision === "ask" ? "ask" : "deny", tool, args, req });
  }

  // 2) error / deny → anında result
  for (const p of plans) {
    if (p.kind === "error" || p.kind === "deny") {
      const result = p.kind === "error"
        ? errResult(p.call.name, p.errorContent!)
        : errResult(p.call.name, "kullanıcı reddetti");
      yield { type: "tool.request", toolCall: p.call };
      results[p.index] = { id: p.call.id, name: p.call.name, result };
      yield { type: "tool.result", toolCallId: p.call.id, result };
    }
  }

  // 3) auto (allow) → paralel
  const autoPlans = plans.filter((p) => p.kind === "run");
  for (const p of autoPlans) yield { type: "tool.request", toolCall: p.call };
  const autoResults = await Promise.all(
    autoPlans.map((p) => p.tool!.run(p.args!, { cwd: deps.cwd, signal: deps.signal })),
  );
  for (let k = 0; k < autoPlans.length; k++) {
    const p = autoPlans[k];
    results[p.index] = { id: p.call.id, name: p.call.name, result: autoResults[k] };
    yield { type: "tool.result", toolCallId: p.call.id, result: autoResults[k] };
  }

  // 4) gated (ask) → sıralı
  for (const p of plans.filter((pp) => pp.kind === "ask")) {
    yield { type: "tool.request", toolCall: p.call };
    yield {
      type: "permission.ask",
      requestId: p.call.id,
      toolName: p.call.name,
      permissionLevel: p.tool!.permissionLevel,
      preview: p.req!.preview,
    };
    const ok = await deps.approve(p.req!);
    const result = ok
      ? await p.tool!.run(p.args!, { cwd: deps.cwd, signal: deps.signal })
      : errResult(p.call.name, "kullanıcı reddetti");
    results[p.index] = { id: p.call.id, name: p.call.name, result };
    yield { type: "tool.result", toolCallId: p.call.id, result };
  }

  return results;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/agent/tool-exec.test.ts`
Expected: PASS (tüm alt testler).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-exec.ts test/agent/tool-exec.test.ts
git commit -m "feat: executeToolCalls (permission + paralel allow / sıralı ask + seam)"
```

---

### Task 3: runRoleAgent + runToCompletion (loop)

**Files:**
- Create: `src/agent/loop.ts`
- Test: `test/agent/loop.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `ChatRequest`, `Message`, `Provider`, `ToolCall` (`src/core/types.js`); `PermissionEngine`, `PermissionRequest` (`src/permission/engine.js`); `ToolRegistry` (`src/tools/registry.js`); `executeToolCalls` (`./tool-exec.js`)
- Produces:
  - `interface RoleAgentOptions { provider: Provider; model: string; systemPrompt: string; tools: ToolRegistry; messages: Message[]; permission: PermissionEngine; approve: (req: PermissionRequest) => Promise<boolean>; cwd: string; signal: AbortSignal }`
  - `runRoleAgent(opts): AsyncGenerator<AgentEvent, void, void>` — konuşma döngüsü: provider stream → `message.delta`/`usage`; tool-call yoksa `message.done` + biter; varsa tool'ları çalıştır, sonuçları history'e ekle, tekrar. `error` → `error` event + biter.
  - `runToCompletion(opts): Promise<Message>` — stream'i drain edip son `message.done`'un mesajını döner; `error`'da `Error` fırlatır.

- [ ] **Step 1: Başarısız testi yaz**

`test/agent/loop.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runRoleAgent, runToCompletion, type RoleAgentOptions } from "../../src/agent/loop.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, ChatEvent, Tool } from "../../src/core/types.js";

const safeEcho: Tool = {
  name: "echo",
  description: "döner",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function opts(provider: MockProvider, over: Partial<RoleAgentOptions> = {}): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "sen bir test rolüsün",
    tools: registry(safeEcho),
    messages: [{ role: "user", content: "merhaba" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("runRoleAgent", () => {
  it("tek turn: text-delta yayar, message.done ile biter", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "sel" }, { type: "text-delta", text: "am" }, { type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([
      { type: "message.delta", text: "sel" },
      { type: "message.delta", text: "am" },
      { type: "message.done", message: { role: "assistant", content: "selam" } },
    ]);
  });

  it("systemPrompt ve user mesajı ilk isteğe gider", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await drain(runRoleAgent(opts(p)));
    expect(p.requests[0].messages).toEqual([
      { role: "system", content: "sen bir test rolüsün" },
      { role: "user", content: "merhaba" },
    ]);
  });

  it("tool-call turn'ü: tool çalışır, sonuç ikinci isteğe eklenir, sonra biter", async () => {
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }],
    ]);
    const events = await drain(runRoleAgent(opts(p)));
    // tool.request + tool.result yayıldı
    expect(events.some((e) => e.type === "tool.request")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    // ikinci istekte tool sonucu mesajı var
    const secondMsgs = p.requests[1].messages;
    expect(secondMsgs).toContainEqual({ role: "tool", toolCallId: "c1", name: "echo", content: "echo:x" });
    // son event final assistant mesajı
    expect(events.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "bitti" } });
  });

  it("provider error → error event yayar ve biter", async () => {
    const p = new MockProvider([[{ type: "error", message: "patladı" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([{ type: "error", message: "patladı" }]);
  });
});

describe("runToCompletion", () => {
  it("son assistant mesajını döner", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "cevap" }, { type: "done", finishReason: "stop" }]]);
    const msg = await runToCompletion(opts(p));
    expect(msg).toEqual({ role: "assistant", content: "cevap" });
  });

  it("error'da fırlatır", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runToCompletion(opts(p))).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/loop.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/agent/loop.ts` yaz**

```typescript
import type {
  AgentEvent, ChatRequest, Message, Provider, ToolCall,
} from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeToolCalls } from "./tool-exec.js";

export interface RoleAgentOptions {
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: ToolRegistry;
  messages: Message[];
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
}

export async function* runRoleAgent(opts: RoleAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const working: Message[] = [{ role: "system", content: opts.systemPrompt }, ...opts.messages];
  const schemas = opts.tools.schemas();

  while (true) {
    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    let errored = false;
    // messages: her turn'de snapshot (kopya) — provider iç diziyi referansla tutmasın
    const req: ChatRequest = { model: opts.model, messages: [...working], tools: schemas };

    for await (const ev of opts.provider.chat(req, opts.signal)) {
      if (ev.type === "text-delta") {
        assistantText += ev.text;
        yield { type: "message.delta", text: ev.text };
      } else if (ev.type === "tool-call") {
        toolCalls.push(ev.toolCall);
      } else if (ev.type === "usage") {
        yield { type: "usage", promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
      } else if (ev.type === "error") {
        yield { type: "error", message: ev.message };
        errored = true;
        break;
      }
      // "done" → yok say; döngü toolCalls'a göre karar verir
    }
    if (errored) return;

    const assistantMsg: Message = {
      role: "assistant",
      content: assistantText,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    working.push(assistantMsg);
    yield { type: "message.done", message: assistantMsg };

    if (toolCalls.length === 0) return;

    const results = yield* executeToolCalls(toolCalls, {
      tools: opts.tools,
      permission: opts.permission,
      approve: opts.approve,
      cwd: opts.cwd,
      signal: opts.signal,
    });
    for (const r of results) {
      working.push({ role: "tool", toolCallId: r.id, name: r.name, content: r.result.content });
    }
    // döngü başa döner → LLM tool sonuçlarını görür
  }
}

export async function runToCompletion(opts: RoleAgentOptions): Promise<Message> {
  let last: Message | undefined;
  for await (const ev of runRoleAgent(opts)) {
    if (ev.type === "message.done") last = ev.message;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  if (!last) throw new Error("runToCompletion: mesaj üretilmedi");
  return last;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/agent/loop.test.ts`
Expected: PASS (tüm alt testler).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts test/agent/loop.test.ts
git commit -m "feat: runRoleAgent + runToCompletion (tool-calling role loop)"
```

---

### Task 4: Config `roles` Genişletmesi

**Files:**
- Modify: `src/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces:
  - `interface RoleConfig { models: string[]; systemPrompt?: string }` (export)
  - `ResolvedConfig`'e `roles: Record<string, RoleConfig>` (varsayılan `{}`).
  - `loadConfig` `roles`'ü katmanlı yükler: global + proje **shallow merge** (aynı adlı role proje'de global'i ezer). Proje config'i role taşıyabilir (apiKey guard'ı aynen geçerli — roller apiKey taşımaz).

- [ ] **Step 1: Başarısız testi yaz (mevcut config testine ekle)**

`test/config/config.test.ts` içindeki `describe("loadConfig", ...)` bloğuna ekle:
```typescript
  it("roles yoksa boş nesne döner", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.roles).toEqual({});
  });

  it("global ve proje roles'ü birleşir, aynı adlı role projede ezilir", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ roles: { coder: { models: ["g-model"] }, refiner: { models: ["r"] } } });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ roles: { coder: { models: ["p-model"], systemPrompt: "proj" } } });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.roles.coder).toEqual({ models: ["p-model"], systemPrompt: "proj" });
    expect(cfg.roles.refiner).toEqual({ models: ["r"] });
  });
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL — `cfg.roles` undefined.

- [ ] **Step 3: `src/config/config.ts` düzenle**

`ResolvedConfig` arayüzünün ÜSTÜNE `RoleConfig`'i ekle ve `ResolvedConfig`'e `roles` alanı ekle:
```typescript
export interface RoleConfig {
  models: string[];
  systemPrompt?: string;
}

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mode: PermissionMode;
  allowlist: string[];
  roles: Record<string, RoleConfig>;
}
```

`DEFAULT_CONFIG`'e ekle:
```typescript
  roles: {},
```

`fileSchema`'ya `roles` alanını ekle (mevcut alanların yanına):
```typescript
    roles: z
      .record(z.object({ models: z.array(z.string()), systemPrompt: z.string().optional() }))
      .optional(),
```

`loadConfig` içinde, `merged.allowlist = ...` satırından SONRA ekle:
```typescript
  // roles: global + proje shallow merge (aynı adlı role projede ezilir).
  merged.roles = { ...(global.roles ?? {}), ...(projectSafe.roles ?? {}) };
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm testler**

Run: `npx vitest run test/config/config.test.ts && npm test`
Expected: PASS; tüm suite yeşil.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: config roles genişletmesi (katmanlı, shallow merge)"
```

---

### Task 5: RoleRegistry + runRole (round-robin + prompt)

**Files:**
- Create: `src/agent/roles.ts`
- Test: `test/agent/roles.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `Provider` (`src/core/types.js`); `RoleConfig` (`src/config/config.js`); `RoleAgentOptions`, `runRoleAgent` (`./loop.js`)
- Produces:
  - `class RoleRegistry` — kurucu `(roles: Record<string, RoleConfig>, defaultPrompts?: Record<string, string>)`; `resolve(roleName): { model: string; systemPrompt: string }` — **role başına round-robin** model + prompt (config > default; ikisi de yoksa hata); tanımsız role / boş models → hata.
  - `runRole(registry, provider, roleName, input): AsyncIterable<AgentEvent>` — `input` = `Omit<RoleAgentOptions, "provider" | "model" | "systemPrompt">`; resolve + `runRoleAgent`.

- [ ] **Step 1: Başarısız testi yaz**

`test/agent/roles.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RoleRegistry, runRole } from "../../src/agent/roles.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent } from "../../src/core/types.js";

describe("RoleRegistry.resolve", () => {
  it("round-robin ile modeller arasında döner (role başına)", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b"], systemPrompt: "p" } });
    expect(reg.resolve("coder").model).toBe("a");
    expect(reg.resolve("coder").model).toBe("b");
    expect(reg.resolve("coder").model).toBe("a");
  });

  it("prompt önceliği: config > default", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["a"], systemPrompt: "cfg" }, analyst: { models: ["a"] } },
      { coder: "def", analyst: "def-analyst" },
    );
    expect(reg.resolve("coder").systemPrompt).toBe("cfg");
    expect(reg.resolve("analyst").systemPrompt).toBe("def-analyst");
  });

  it("tanımsız role / boş models / prompt yok → hata", () => {
    const reg = new RoleRegistry({ x: { models: [] }, y: { models: ["a"] } });
    expect(() => reg.resolve("yok")).toThrow(/tanımsız role/);
    expect(() => reg.resolve("x")).toThrow(/model/);
    expect(() => reg.resolve("y")).toThrow(/systemPrompt/);
  });
});

describe("runRole", () => {
  it("resolve edip runRoleAgent'ı çalıştırır (round-robin tüketir)", async () => {
    const reg = new RoleRegistry({ coder: { models: ["m1", "m2"], systemPrompt: "sp" } });
    const provider = new MockProvider([
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const input = {
      tools: new ToolRegistry(),
      messages: [{ role: "user" as const, content: "hi" }],
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      cwd: "/tmp",
      signal: new AbortController().signal,
    };
    const out: AgentEvent[] = [];
    for await (const ev of runRole(reg, provider, "coder", input)) out.push(ev);
    expect(out.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "ok" } });
    // resolve edilen model ilk istekte kullanıldı
    expect(provider.requests[0].model).toBe("m1");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/roles.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/agent/roles.ts` yaz**

```typescript
import type { AgentEvent, Provider } from "../core/types.js";
import type { RoleConfig } from "../config/config.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";

export class RoleRegistry {
  private index = new Map<string, number>();

  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
  ) {}

  resolve(roleName: string): { model: string; systemPrompt: string } {
    const role = this.roles[roleName];
    if (!role) throw new Error(`tanımsız role: ${roleName}`);
    if (!role.models.length) throw new Error(`role '${roleName}' için model tanımlı değil`);

    const i = this.index.get(roleName) ?? 0;
    const model = role.models[i % role.models.length];
    this.index.set(roleName, i + 1);

    const systemPrompt = role.systemPrompt ?? this.defaultPrompts[roleName];
    if (systemPrompt === undefined) throw new Error(`role '${roleName}' için systemPrompt yok`);

    return { model, systemPrompt };
  }
}

export function runRole(
  registry: RoleRegistry,
  provider: Provider,
  roleName: string,
  input: Omit<RoleAgentOptions, "provider" | "model" | "systemPrompt">,
): AsyncIterable<AgentEvent> {
  const { model, systemPrompt } = registry.resolve(roleName);
  return runRoleAgent({ provider, model, systemPrompt, ...input });
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm testler**

Run: `npx vitest run test/agent/roles.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; typecheck hatasız.

- [ ] **Step 5: Commit**

```bash
git add src/agent/roles.ts test/agent/roles.test.ts
git commit -m "feat: RoleRegistry (round-robin + prompt) + runRole"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B1 + B2 + C)
- [ ] `git log --oneline` — bu dilimde 5 commit

Bu dilim şunu teslim eder: `MockProvider`, permission-entegre `executeToolCalls`, `runRoleAgent`/`runToCompletion` role-agent döngüsü, `RoleRegistry` (round-robin) + `runRole`, ve config `roles` yüklemesi. Sonraki dilim **D — Worktree manager** bağımsızdır; **E — Board engine** bu role-agent primitifini tüketerek coder/reviewer/team-lead'i koşturur.

## Kapsam Dışı (bilinçli — sonraki dilimler)

- structured output (refiner/judge) → Dilim F. Loop jenerik metin + tool-calling üretir.
- gerçek per-role prompt içerikleri (`defaultPrompts` bu dilimde boş bırakılabilir) → F/G.
- councilor çözümü (aynı round-robin mekanizması) → F.
- context compaction, turn'ler arası paralellik, retry/backoff.
- gerçek pipeline/board/worktree orkestrasyonu → E–G.
