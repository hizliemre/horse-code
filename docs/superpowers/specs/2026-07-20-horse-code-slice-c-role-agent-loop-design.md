# horse-code Dilim C — Role-agent İç Döngüsü Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§3.1 iç döngü, §4 config/round-robin)

---

## 1. Amaç ve Kapsam

Bu dilim, çok-ajanlı orkestrasyonun **yeniden kullanılabilir çekirdek primitifini** inşa eder:
`(model, systemPrompt, toolset, workdir)` ile parametrelenmiş **tek bir tool-calling LLM
döngüsü** ve bu döngüyü role adından çözen **RoleRegistry** (round-robin + prompt yükleme).
Her role (coder, analyst, reviewer, judge…) bu primitifin bir örneğidir; dış orkestrasyon
(Dilim E–G) bunları kompoze eder.

**Tüketir (hepsi tamam):**
- **B1 — Provider:** `Provider.chat(req, signal): AsyncIterable<ChatEvent>` (`src/providers/omniroute.ts`)
- **B2 — Tools/Registry:** `ToolRegistry` (`schemas()` + `get(name)`), `Tool` (+ `describe?`), `ToolResult`, `ToolContext` (`src/tools/`, `src/core/types.ts`)
- **Foundation — Permission:** `PermissionEngine.check(req)`, `PermissionRequest {level, preview, allowKey}` (`src/permission/`)
- **Foundation — Tipler:** `Message`, `ChatRequest`, `ChatEvent`, `AgentEvent`, `ToolCall` (`src/core/types.ts`)

**Katmanlama içgörüsü:** Bu, önceki spec'in "tek agent loop"unun genelleştirilmiş halidir —
model/prompt/tool ile parametrelenir, `AgentEvent` yayar. Dış orkestrasyon değişmez;
sadece bu primitifi çağırır.

---

## 2. Birimler

Üç birim, artan soyutlama:

```
runRoleAgent(opts): AsyncIterable<AgentEvent>     ← çekirdek loop (model/prompt/tools verili)
runToCompletion(opts): Promise<Message>           ← drain helper (fonksiyon-gibi çağrı)
RoleRegistry.resolve(roleName) → {model, systemPrompt}   ← round-robin + prompt çözümü
  + runRole(registry, provider, roleName, input): AsyncIterable<AgentEvent>  ← kolaylık
```

---

## 3. Birim 1 — `runRoleAgent` (çekirdek loop)

### 3.1 Arayüz

```typescript
export interface RoleAgentOptions {
  provider: Provider;                                  // B1
  model: string;                                       // round-robin ile seçilmiş tek model id
  systemPrompt: string;                                // system mesajı olarak eklenir
  tools: ToolRegistry;                                 // schemas() → istek · get(name) → çalıştırma
  messages: Message[];                                 // başlangıç konuşması (user turn vb.)
  permission: PermissionEngine;                        // Foundation (stateful: mode + allowlist)
  approve: (req: PermissionRequest) => Promise<boolean>; // "ask" kararı (enjekte)
  signal: AbortSignal;
  cwd: string;                                         // tool ToolContext.cwd
}

export function runRoleAgent(opts: RoleAgentOptions): AsyncIterable<AgentEvent>;
```

> `tools` neden `ToolRegistry`, `Tool[]` değil: registry hem `schemas()` (istek gövdesi için
> zod→JSON Schema) hem `get(name)` (çalıştırma için Tool) verir — tek kaynak. Alt-küme tool'lu
> bir role için çağıran yalnızca o tool'larla bir registry kurar.

### 3.2 Döngü algoritması

```
working = [ {role:"system", content: systemPrompt}, ...opts.messages ]
schemas = tools.schemas()

loop:
  assistantText = ""
  toolCalls = []
  finishReason = "stop"
  for await (ev of provider.chat({ model, messages: working, tools: schemas }, signal)):
    text-delta → assistantText += ev.text; YIELD {type:"message.delta", text: ev.text}
    tool-call  → toolCalls.push(ev.toolCall)
    usage      → YIELD {type:"usage", ...}
    done       → finishReason = ev.finishReason
    error      → YIELD {type:"error", message: ev.message}; RETURN

  assistantMsg = { role:"assistant", content: assistantText,
                   toolCalls: toolCalls.length ? toolCalls : undefined }
  working.push(assistantMsg)
  YIELD {type:"message.done", message: assistantMsg}

  if toolCalls.length === 0:
    RETURN                       // final assistant cevabı

  results = yield* executeToolCalls(toolCalls, opts)   // AgentEvent yayar, sonuçları döner
  for (r of results in ÇAĞRI SIRASI):                  // sıra korunur (id ile eşle)
    working.push({ role:"tool", toolCallId: r.id, name: r.name, content: r.result.content })
  // loop başa döner → LLM tool sonuçlarını görür
```

`abort`: `provider.chat`'e `signal` geçer; iptalde provider `error` event'i yayar (B1'de
mid-stream sarmalandı) → loop `error` yayıp döner. Çalışan tool'lara da `ctx.signal` geçer.

### 3.3 Tool çalıştırma — `executeToolCalls` (paralel allow + sıralı ask)

Her tool-call için **permission kararı**:
- `tool = registry.get(call.name)`; **yoksa** → korele hata result `{isError:true, "bilinmeyen tool: <name>"}`, çalıştırma yok.
- `call.id === ""` → **seam kontratı:** korele edilemez → hata result `{isError:true, "geçersiz tool-call id"}`, çalıştırma yok (yine de result üretilir ki her tool-call'un bir tool mesajı olsun).
- `tool.permissionLevel === "safe"` → karar `allow` (describe/check gerekmez).
- değilse: `desc = tool.describe?.(args)` **try/catch içinde** (throw → hata result, çalıştırma yok); `check({ level: tool.permissionLevel, preview: desc.preview, allowKey: desc.allowKey })` → `allow` | `ask` | `deny`.

Kararlara göre **iki grup**:
- **auto** (`allow`) → `Promise.all` ile **paralel** çalışır. Her biri için başlarken `tool.request` yayılır; biten her biri için `tool.result` yayılır.
- **gated** (`ask`) → **sıralı**: `tool.request` yay → `permission.ask` yay → `ok = await approve(req)` → `ok` ise çalıştır, değilse deny result `{isError:true, "kullanıcı reddetti"}` → `tool.result` yay.
- `deny` (engine nadiren üretir; savunmacı) → çalıştırmadan deny result.

Her tool `run(args, {cwd, signal})` çağrılır; tool'lar zaten **throw etmez** (B2 sözleşmesi) →
`Promise.all` reddi olmaz. Sonuçlar **çağrı sırasına göre** toplanıp döner
(`{ id, name, result }[]`), event sırası paralelde harmanlanabilir ama history sırası korunur.

### 3.4 Yayılan AgentEvent'ler

`message.delta`, `message.done`, `tool.request`, `tool.result`, `permission.ask`, `usage`,
`error`. (`abort` event'i UI tarafında; loop iptali `error`/erken return ile görünür.)

---

## 4. Birim 2 — `runToCompletion`

```typescript
export async function runToCompletion(opts: RoleAgentOptions): Promise<Message>;
```

`runRoleAgent`'ı drain eder, **son `message.done`'un mesajını** döner (tool-call taşımayan,
yani final assistant cevabı). `error` event'i görülürse `Error` fırlatır (çağıran orkestrasyon
yakalar). Dış orkestrasyon role-agent'ı "fonksiyon gibi" böyle çağırır.

---

## 5. Birim 3 — `RoleRegistry` (round-robin + prompt)

### 5.1 Config şeması genişletmesi

Foundation `ResolvedConfig`'e (`src/config/config.ts`) opsiyonel `roles` eklenir:

```typescript
interface RoleConfig { models: string[]; systemPrompt?: string }
// ResolvedConfig'e: roles?: Record<string, RoleConfig>
```

`loadConfig` file şemasına `roles` (ve ileride `council.councilors`) eklenir; katman önceliği
aynı (default → global → proje → env). Proje config'i model listesi/prompt taşıyabilir (apiKey
sızıntı guard'ı aynen geçerli).

### 5.2 Arayüz + round-robin

```typescript
export class RoleRegistry {
  constructor(roles: Record<string, RoleConfig>, defaultPrompts?: Record<string, string>);
  resolve(roleName: string): { model: string; systemPrompt: string };
}
```

- `resolve`: `roles[roleName]` yoksa → net hata (`"tanımsız role: <name>"`).
- **Model:** `models[index++ % models.length]` — **role başına ayrı, deterministik** dönen index (Math.random YOK). Boş `models` → hata.
- **Prompt:** `roles[roleName].systemPrompt` varsa onu; yoksa `defaultPrompts[roleName]`; o da yoksa net hata (role prompt'suz çalıştırılamaz).

> `defaultPrompts` — pakette gömülü varsayılan role prompt'ları. **Bu dilimde içerikleri boş/
> yer tutucu** olabilir; gerçek prompt metinleri role'ler wire edilirken (Dilim F/G) yazılır.
> Mekanizma (config override > default) burada kurulur.

### 5.3 Kolaylık sarmalayıcı

```typescript
export function runRole(
  registry: RoleRegistry,
  provider: Provider,
  roleName: string,
  input: { messages: Message[]; tools: ToolRegistry; permission: PermissionEngine;
           approve: (req: PermissionRequest) => Promise<boolean>; signal: AbortSignal; cwd: string },
): AsyncIterable<AgentEvent>;
```

`registry.resolve(roleName)` → `{model, systemPrompt}` + input → `runRoleAgent`. Round-robin
tüketimi burada gerçekleşir (her `runRole` çağrısı bir sonraki modeli seçer).

---

## 6. Veri Akışı

```
runRole(registry, provider, "coder", {messages, tools, permission, approve, signal, cwd})
   │  registry.resolve("coder") → {model: round-robin, systemPrompt}
   ▼
runRoleAgent
   │  ┌───────────────────────────────────────────────┐
   │  │ provider.chat(model, [system,...working], schemas)│──► ChatEvent stream
   │  │   text-delta/tool-call/usage/done/error          │
   │  └───────────────────────────────────────────────┘
   │  tool-call var → executeToolCalls (paralel allow + sıralı ask)
   │     permission.check · approve · tool.run(cwd,signal)
   │     → tool sonuçları history'e (çağrı sırası) → başa dön
   ▼
AgentEvent stream (UI abone) · runToCompletion → son Message
```

---

## 7. Test Stratejisi

- **`MockProvider`** (`src/providers/mock.ts`) — `Provider`'ı uygulayan, önceden yazılmış
  (scripted) `ChatEvent` dizileri yayan test double'ı. Turn-başına script (ör. 1. turn tool-call,
  2. turn text+done) ile çok-turlu loop'lar deterministik test edilir. (Gerçek, sevkedilebilir
  bir yardımcı; omniroute'a gerek kalmadan tüm role/loop testleri bununla koşar.)
- **runRoleAgent testleri:** MockProvider + gerçek `createDefaultRegistry` (veya alt-küme) +
  gerçek `PermissionEngine` + enjekte `approve`. Doğrulanır: text-delta yayımı; tek-turn final;
  tool-call → tool çalıştırma → sonuç history'e → ikinci turn; `permission.ask` + approve(true/false);
  paralel safe tool'lar; bilinmeyen tool / boş id → hata result; abort → error.
- **RoleRegistry testleri:** round-robin index (aynı role ardışık çağrıda models arasında döner);
  prompt önceliği (config > default > hata); tanımsız role hatası.
- **config testleri:** `roles` katmanlı yükleme.
- Tümü `vitest`, TDD.

---

## 8. Dilim C DIŞI (bilinçli ertelenen)

- **structured output** (refiner `{refinedPrompt, intent}`, judge kararı) → Dilim F. C'nin loop'u
  jenerik metin + tool-calling üretir.
- **per-role toolset** tanımı ve **gerçek prompt içerikleri** → çağıran/F-G tanımlar.
- **councilor** çözümü → aynı round-robin mekanizması; wiring Dilim F (council).
- context compaction, turn'ler arası paralellik, retry/backoff (B1'de failover omniroute'ta).
- gerçek pipeline/board/worktree orkestrasyonu → Dilim E–G.

---

## 9. Seam Kontratları (nihai B1/B2 review'ından)

- `Tool.describe()` malformed args'ta **throw edebilir** → `executeToolCalls` onu try/catch'ler,
  hata result üretir.
- Provider tool-call **`id:""` taşıyabilir** → çalıştırmadan doğrulanır, korele hata result.

---

## 10. Açık Noktalar / İleride

- `approve` "her zaman izin ver" seçeneğinde `PermissionEngine.addAllow` çağrısı — bu UI/çağıran
  sorumluluğu (Dilim H); C yalnızca boolean karar alır.
- `runToCompletion` `error`'da fırlatır; orkestrasyon (E–G) retry/escalation politikasını üstte kurar.
- `MockProvider` script formatının kesin şekli (turn dizisi) plan aşamasında netleşir.
