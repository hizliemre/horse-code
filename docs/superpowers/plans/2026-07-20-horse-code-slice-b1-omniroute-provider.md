# horse-code Dilim B1 — omniroute Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** omniroute gateway'ine OpenAI-uyumlu `/api/v1/chat/completions` üzerinden bağlanan, SSE stream'i ve tool-calling'i `ChatEvent` akışına çeviren `OmniRouteProvider`'ı inşa etmek — `fetch` enjekte edilebilir, tamamen bellekte test edilebilir.

**Architecture:** `Provider` arayüzü (`src/core/types.ts`) zaten tanımlı; bu dilim onun tek somut uygulamasını yazar. Üç saf yardımcı katman — SSE satır ayrıştırıcı (`sse.ts`), bizim tiplerimiz ↔ OpenAI gövde eşlemesi (`openai.ts`), ve provider'ın kendisi (`omniroute.ts`) — sorumluluğa göre bölünür. Provider `fetch`'i kurucudan enjekte alır; testler sahte `fetch` + bellek içi `ReadableStream` ile çalışır, ağ yok.

**Tech Stack:** TypeScript (ESM), Node ≥ 20 (yerleşik `fetch`, `Response`, `ReadableStream`, `TextDecoder`, `AbortSignal`), `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20 (yerleşik `fetch`/`Response`/`ReadableStream`/`AbortController` — polyfill yok).
- TypeScript ESM (`"type": "module"`), `strict: true`, `moduleResolution: "bundler"`.
- Relative import'lar `.js` uzantılı yazılır (ESM + `bundler` çözümü).
- Provider ince bir transport'tur: model seçim/round-robin/retry politikası burada YOK (üst katmanların işi). Sadece tek `model` alır, tek istek atar, `ChatEvent` yayar.
- omniroute sözleşmesi: `docs/superpowers/reference/omniroute-api.md`. Base `http://localhost:20128`, path `/api/v1/chat/completions`, auth `Authorization: Bearer <key>`, SSE `stream:true`. Usage `X-OmniRoute-Tokens-In/Out` header'larından. Hata gövdesi TUTARSIZ: 401 → `{ "error": "<string>" }`, diğerleri → `{ "error": { "message": "..." } }` — iki biçim de ele alınır.
- SSE ve `tool_calls` yapıları omniroute spec'inde tiplenmemiş → OpenAI konvansiyonuyla **defensive parse** (eksik alan → atla, çökme yok).
- Tüketilen mevcut tipler (`src/core/types.ts`, DEĞİŞTİRİLMEZ): `Provider`, `ChatRequest`, `ChatEvent`, `Message`, `ToolCall`.
- Test framework `vitest`; her task TDD (önce başarısız test).

---

### Task 1: SSE Satır Ayrıştırıcı

**Files:**
- Create: `src/providers/sse.ts`
- Test: `test/providers/sse.test.ts`

**Interfaces:**
- Consumes: (yok — saf async generator, `ReadableStream<Uint8Array>` girer)
- Produces: `parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string>` — her `data: <payload>` satırının `<payload>`'unu (trim'li) yield eder; `[DONE]` görülünce durur; chunk sınırında bölünen satırları buffer'da birleştirir; `data:` olmayan/boş satırları atlar.

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/sse.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseSSE } from "../../src/providers/sse.js";

// Bellek içi SSE gövdesi üretir (ağ yok).
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseSSE", () => {
  it("data satırlarının payload'unu yield eder, [DONE]'da durur", async () => {
    const body = streamFrom([
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseSSE(body))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("chunk sınırında bölünen satırı birleştirir", async () => {
    const body = streamFrom(['data: {"a":', "1}\n", "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual(['{"a":1}']);
  });

  it("data olmayan ve boş satırları atlar", async () => {
    const body = streamFrom([": keep-alive\n", "\n", 'data: {"x":true}\n', "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual(['{"x":true}']);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/providers/sse.test.ts`
Expected: FAIL — `Cannot find module '../../src/providers/sse.js'`.

- [ ] **Step 3: `src/providers/sse.ts` yaz**

```typescript
/**
 * SSE gövdesini (text/event-stream) ayrıştırır. Her "data: <payload>" satırının
 * payload'unu yield eder; "[DONE]" görülünce durur. Chunk sınırlarında bölünen
 * satırlar buffer'da birleştirilir. "data:" ile başlamayan satırlar atlanır.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (payload) yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/sse.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/providers/sse.ts test/providers/sse.test.ts
git commit -m "feat: SSE satır ayrıştırıcı (parseSSE)"
```

---

### Task 2: OpenAI Gövde Eşlemesi

**Files:**
- Create: `src/providers/openai.ts`
- Test: `test/providers/openai.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `Message` (`src/core/types.js`)
- Produces:
  - `toOpenAIMessages(messages: Message[]): unknown[]` — bizim `Message` → OpenAI mesaj objesi (assistant+toolCalls → `tool_calls[]`; role `tool` → `tool_call_id`+`content`; `name` taşınır).
  - `toOpenAITools(tools: ChatRequest["tools"]): unknown[] | undefined` — boşsa `undefined`, doluysa `{ type:"function", function:{ name, description, parameters } }[]`.
  - `toOpenAIBody(req: ChatRequest): Record<string, unknown>` — `{ model, messages, stream:true }` + tool varsa `tools`/`tool_choice:"auto"`/`parallel_tool_calls:true`.
  - `mapFinishReason(reason: string | null | undefined): "stop" | "tool_calls" | "length"` — bilinmeyen/`content_filter`/`null` → `"stop"`.

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/openai.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIBody,
  mapFinishReason,
} from "../../src/providers/openai.js";
import type { ChatRequest } from "../../src/core/types.js";

describe("toOpenAIMessages", () => {
  it("assistant tool çağrılarını tool_calls[] olarak eşler", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: '{"p":"a"}' }] },
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } }],
      },
    ]);
  });

  it("tool sonucu mesajını tool_call_id ile eşler", () => {
    const out = toOpenAIMessages([{ role: "tool", content: "ok", toolCallId: "c1", name: "read" }]);
    expect(out).toEqual([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  });

  it("düz user mesajını olduğu gibi taşır", () => {
    expect(toOpenAIMessages([{ role: "user", content: "merhaba" }])).toEqual([
      { role: "user", content: "merhaba" },
    ]);
  });
});

describe("toOpenAITools", () => {
  it("boş listede undefined döner", () => {
    expect(toOpenAITools([])).toBeUndefined();
  });
  it("tool'ları function şemasına sarar", () => {
    expect(toOpenAITools([{ name: "read", description: "oku", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "read", description: "oku", parameters: { type: "object" } } },
    ]);
  });
});

describe("toOpenAIBody", () => {
  it("tool yokken tools/tool_choice eklemez, stream:true kalır", () => {
    const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };
    const body = toOpenAIBody(req);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("tool varken tool_choice:auto ve parallel_tool_calls ekler", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read", description: "oku", parameters: {} }],
    };
    const body = toOpenAIBody(req);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe("mapFinishReason", () => {
  it("bilinen değerleri geçirir", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("stop")).toBe("stop");
  });
  it("bilinmeyen/null'ı stop'a düşürür", () => {
    expect(mapFinishReason("content_filter")).toBe("stop");
    expect(mapFinishReason(null)).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/providers/openai.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/providers/openai.ts` yaz**

```typescript
import type { ChatRequest, Message } from "../core/types.js";

export function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) base.name = m.name;
    return base;
  });
}

export function toOpenAITools(
  tools: ChatRequest["tools"],
): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toOpenAIBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    stream: true,
  };
  const tools = toOpenAITools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

export function mapFinishReason(
  reason: string | null | undefined,
): "stop" | "tool_calls" | "length" {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return "stop"; // stop | content_filter | null | undefined → stop
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/openai.test.ts`
Expected: PASS (tüm alt testler).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/providers/openai.ts test/providers/openai.test.ts
git commit -m "feat: OpenAI gövde eşlemesi (mesaj/tool/finish_reason)"
```

---

### Task 3: Hata Gövdesi Okuma

**Files:**
- Create: `src/providers/omniroute.ts` (sadece `readErrorMessage` bu task'ta)
- Test: `test/providers/omniroute-error.test.ts`

**Interfaces:**
- Consumes: (yok — `Response` girer)
- Produces: `readErrorMessage(res: Response): Promise<string>` — omniroute'un TUTARSIZ hata biçimlerini tek string'e indirger: `error` düz string → onu; `error.message` obje → mesajı; JSON parse edilemez/uygun alan yok → `omniroute <status>`.

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/omniroute-error.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readErrorMessage } from "../../src/providers/omniroute.js";

describe("readErrorMessage", () => {
  it("401 düz-string error biçimini okur", async () => {
    const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    expect(await readErrorMessage(res)).toBe("Unauthorized");
  });

  it("obje error.message biçimini okur", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limit", type: "rate_limit" } }), {
      status: 429,
    });
    expect(await readErrorMessage(res)).toBe("rate limit");
  });

  it("JSON olmayan gövdede status'a düşer", async () => {
    const res = new Response("upstream boom", { status: 502 });
    expect(await readErrorMessage(res)).toBe("omniroute 502");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/providers/omniroute-error.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/providers/omniroute.ts` yaz (bu task'ta yalnızca yardımcı)**

```typescript
/**
 * omniroute'un TUTARSIZ hata gövdesini tek mesaja indirger:
 *  - 401: { "error": "<string>" }
 *  - diğer: { "error": { "message": "..." } }
 *  - JSON değilse / uygun alan yoksa: "omniroute <status>"
 */
export async function readErrorMessage(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return `omniroute ${res.status}`;
  }
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return `omniroute ${res.status}`;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/omniroute-error.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Commit**

```bash
git add src/providers/omniroute.ts test/providers/omniroute-error.test.ts
git commit -m "feat: omniroute hata gövdesi okuma (string+obje biçimleri)"
```

---

### Task 4: OmniRouteProvider — Metin Streaming (happy path)

**Files:**
- Modify: `src/providers/omniroute.ts` (`FetchLike`, `OmniRouteOptions`, `OmniRouteProvider` sınıfı eklenir)
- Test: `test/providers/omniroute.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ChatRequest`, `ChatEvent` (`src/core/types.js`); `parseSSE` (`./sse.js`); `toOpenAIBody`, `mapFinishReason` (`./openai.js`); `readErrorMessage` (Task 3).
- Produces:
  - `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`
  - `interface OmniRouteOptions { apiKey?: string; baseUrl: string; fetch?: FetchLike }`
  - `class OmniRouteProvider implements Provider` — kurucu `(opts: OmniRouteOptions)`; `chat(req, signal)` async generator. Bu task: text-delta akışı + sondaki `done`. (tool-call ve usage sonraki task'larda.)

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/omniroute.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ChatRequest = { model: "cc/claude-opus-4-8", messages: [{ role: "user", content: "hi" }], tools: [] };

describe("OmniRouteProvider — metin streaming", () => {
  it("delta.content'leri text-delta olarak yayar ve done ile biter", async () => {
    const fetch: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        "data: [DONE]\n",
      ]);
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("istek gövdesini ve Bearer header'ını doğru kurar", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return sseResponse(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n', "data: [DONE]\n"]);
    };
    const provider = new OmniRouteProvider({ apiKey: "sk-1", baseUrl: "http://localhost:20128/", fetch });
    await drain(provider.chat(req, new AbortController().signal));
    expect(captured?.url).toBe("http://localhost:20128/api/v1/chat/completions");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");
    const sent = JSON.parse(captured?.init?.body as string);
    expect(sent.model).toBe("cc/claude-opus-4-8");
    expect(sent.stream).toBe(true);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/providers/omniroute.test.ts`
Expected: FAIL — `OmniRouteProvider` export yok.

- [ ] **Step 3: `src/providers/omniroute.ts`'e provider'ı ekle**

Dosyanın başına import'ları, `readErrorMessage`'ın ÜSTÜNE tip/arayüzleri, ALTINA sınıfı ekle:

```typescript
import type { ChatEvent, ChatRequest, Provider, ToolCall } from "../core/types.js";
import { parseSSE } from "./sse.js";
import { toOpenAIBody, mapFinishReason } from "./openai.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OmniRouteOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: FetchLike;
}

// (mevcut readErrorMessage burada kalır)

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OmniRouteProvider implements Provider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OmniRouteOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); // sondaki slash'ı at
    this.fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(toOpenAIBody(req)),
        signal,
      });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    if (!res.ok) {
      yield { type: "error", message: await readErrorMessage(res) };
      return;
    }
    const stream = res.body;
    if (!stream) {
      yield { type: "error", message: "omniroute: boş yanıt gövdesi" };
      return;
    }

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: "stop" | "tool_calls" | "length" = "stop";

    for await (const payload of parseSSE(stream)) {
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // bozuk chunk → atla
      }
      const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
        | { delta?: Record<string, unknown>; finish_reason?: string | null }
        | undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length) {
        yield { type: "text-delta", text: delta.content };
      }

      const deltaCalls = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined;
      if (Array.isArray(deltaCalls)) {
        for (const tc of deltaCalls) {
          const idx = tc.index ?? 0;
          const acc = toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          toolCalls.set(idx, acc);
        }
      }

      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
    }

    for (const acc of toolCalls.values()) {
      const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: acc.arguments };
      yield { type: "tool-call", toolCall };
    }

    const inHeader = res.headers.get("X-OmniRoute-Tokens-In");
    const outHeader = res.headers.get("X-OmniRoute-Tokens-Out");
    if (inHeader !== null || outHeader !== null) {
      yield {
        type: "usage",
        promptTokens: Number(inHeader) || 0,
        completionTokens: Number(outHeader) || 0,
      };
    }

    yield { type: "done", finishReason };
  }
}
```

> Not: Sınıf gövdesi tool-call birleştirmeyi ve usage'ı da içeriyor; Task 5 ve 6 bunları ayrı testlerle doğrular (kod tekrar yazılmaz, sadece test eklenir).

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/omniroute.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/providers/omniroute.ts test/providers/omniroute.test.ts
git commit -m "feat: OmniRouteProvider metin streaming (SSE → text-delta/done)"
```

---

### Task 5: OmniRouteProvider — Tool-Call Birleştirme

**Files:**
- Modify: (yok — kod Task 4'te yazıldı)
- Test: `test/providers/omniroute-toolcall.test.ts`

**Interfaces:**
- Consumes: `OmniRouteProvider`, `FetchLike` (Task 4).
- Produces: (yeni API yok — parça parça gelen `delta.tool_calls`'ın `index`'e göre birleştirilip tek `tool-call` event'i olarak yayıldığını doğrular.)

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/omniroute-toolcall.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hava" }], tools: [] };

describe("OmniRouteProvider — tool-call birleştirme", () => {
  it("parça parça gelen tool_calls'ı index'e göre birleştirip tek event yayar", async () => {
    const fetch: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"IST\\"}"}}]},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
        "data: [DONE]\n",
      ]);
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "call_1", name: "get_weather", arguments: '{"city":"IST"}' } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });
});
```

- [ ] **Step 2: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/omniroute-toolcall.test.ts`
Expected: PASS (1 test) — kod Task 4'te yazıldığı için doğrudan geçmeli.

> Bu task davranış doğrulamasıdır: Task 4 kodu tool-call birleştirmeyi zaten içeriyor. Test önce yazılıp bu davranışı kilitler. Geçmezse Task 4 kodundaki birleştirme mantığını düzelt.

- [ ] **Step 3: Commit**

```bash
git add test/providers/omniroute-toolcall.test.ts
git commit -m "test: OmniRouteProvider tool-call birleştirmeyi doğrula"
```

---

### Task 6: OmniRouteProvider — Usage, Hata ve Ağ Kesintisi

**Files:**
- Modify: (yok — kod Task 4'te yazıldı)
- Test: `test/providers/omniroute-usage-error.test.ts`

**Interfaces:**
- Consumes: `OmniRouteProvider`, `FetchLike` (Task 4).
- Produces: (yeni API yok — usage header'larından `usage` event'i; `!res.ok` → tek `error` event'i (stream yok); `fetch` reddi (ör. abort) → tek `error` event'i doğrulanır.)

- [ ] **Step 1: Başarısız testi yaz**

`test/providers/omniroute-usage-error.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };

describe("OmniRouteProvider — usage / hata / kesinti", () => {
  it("usage header'larını done'dan önce usage event'i olarak yayar", async () => {
    const fetch: FetchLike = async () =>
      sseResponse(
        ['data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n', "data: [DONE]\n"],
        { "X-OmniRoute-Tokens-In": "12", "X-OmniRoute-Tokens-Out": "5" },
      );
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "usage", promptTokens: 12, completionTokens: 5 },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("!res.ok durumunda stream açmadan tek error event'i yayar", async () => {
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const provider = new OmniRouteProvider({ apiKey: "bad", baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Unauthorized" }]);
  });

  it("fetch reddi (abort/ağ) tek error event'ine dönüşür", async () => {
    const fetch: FetchLike = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "The operation was aborted." }]);
  });
});
```

- [ ] **Step 2: Testin geçtiğini doğrula**

Run: `npx vitest run test/providers/omniroute-usage-error.test.ts`
Expected: PASS (3 test) — kod Task 4'te yazıldığı için doğrudan geçmeli.

- [ ] **Step 3: Commit**

```bash
git add test/providers/omniroute-usage-error.test.ts
git commit -m "test: OmniRouteProvider usage/hata/kesinti davranışı"
```

---

### Task 7: DEFAULT_CONFIG.baseUrl'ü omniroute'a Hizala

**Files:**
- Modify: `src/config/config.ts:13` (`DEFAULT_CONFIG.baseUrl`)
- Test: `test/config/config.test.ts` (yeni assertion)

**Interfaces:**
- Consumes: (yok)
- Produces: `DEFAULT_CONFIG.baseUrl === "http://localhost:20128"` (omniroute local-first; provider path'i `/api/v1/chat/completions` ekler). Foundation'daki placeholder (`https://api.omniroute.example/v1`) kaldırılır.

- [ ] **Step 1: Başarısız testi yaz (mevcut config testine ekle)**

`test/config/config.test.ts` içindeki `describe("loadConfig", ...)` bloğunun içine ekle:
```typescript
  it("varsayılan baseUrl omniroute local-first adresidir", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.baseUrl).toBe("http://localhost:20128");
  });
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL — `expected 'https://api.omniroute.example/v1' to be 'http://localhost:20128'`.

- [ ] **Step 3: `src/config/config.ts` düzelt**

`DEFAULT_CONFIG` içindeki satırı değiştir:
```typescript
  baseUrl: "http://localhost:20128",
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/config/config.test.ts`
Expected: PASS (tüm config testleri).

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: DEFAULT_CONFIG.baseUrl'ü omniroute local-first'e hizala"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + sse + openai + omniroute × 4 + config)
- [ ] `git log --oneline` — bu dilimde 7 commit

Bu dilim şunu teslim eder: omniroute'a bağlanan, SSE stream'i ve tool-calling'i `ChatEvent` akışına çeviren, `fetch` enjekte edilebilir tam test edilmiş `OmniRouteProvider`. Sonraki plan **B2 — Tools + Registry** bağımsızdır; **C — Role-agent iç döngüsü** bu provider'ı ve B2 tool'larını tüketir.

## Kapsam Dışı (bilinçli — sonraki dilimler)

- `GET /api/v1/models` model listeleme (yalnızca `/model` komutu için gerekir → Dilim H).
- Retry/backoff, round-robin, model seçimi (üst katman → Dilim C engine).
- `/api/v1/messages` native-Claude endpoint'i (MVP dışı).
- Non-streaming yanıt yolu (MVP hep `stream:true` kullanır).
