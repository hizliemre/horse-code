# OmniRoute API — Provider Sözleşmesi (Dilim 3 referansı)

Kaynak: `http://localhost:20128/openapi.yaml` (OmniRoute API v3.8.35) + `/api/v1/models` örneği.
`OmniRouteProvider` yazımında bu belge esas alınır.

> **Genel uyarı:** Spec OpenAI-uyumlu olduğunu söylüyor ama `tools`, `tool_calls`,
> streaming delta ve SSE chunk yapılarını **tiplemez** (`type: object`/`string` bırakır).
> Bu yapılar için OpenAI konvansiyonunu uygula, defensive parse et — spec garanti vermiyor.

## 1. Auth
- `Authorization: Bearer <API_KEY>` (x-api-key DEĞİL). Tüm `/api/v1/*` proxy endpoint'leri Bearer ister.
- Key OmniRoute dashboard'undan alınır.

## 2. Base URL / endpoint
- `servers: http://localhost:20128` (local-first).
- Path prefix `/api/v1`. Tam endpoint: `http://localhost:20128/api/v1/chat/completions`.
- **Config etkisi:** `DEFAULT_CONFIG.baseUrl = "http://localhost:20128"`, provider path'i `/api/v1/chat/completions` ekler. (Foundation planındaki placeholder baseUrl bununla değişecek.)

## 3. POST /api/v1/chat/completions — Request
`required: [model, messages]`. Ana alanlar:
`model` (str), `messages` (array), `stream` (bool, default false), `temperature` (0–2),
`max_tokens` (int), `top_p`, `n`, `stop`, `frequency_penalty`, `presence_penalty`, `seed`,
`response_format`, `tools` (array<object>), `tool_choice` (str|obj, örn "auto"),
`parallel_tool_calls` (bool, default true), `user`.

Message objesi (`required: [role]`):
```jsonc
{ "role": "user|assistant|system|tool",
  "content": "…" | null,
  "name": "…",
  "tool_call_id": "…",          // role:"tool" mesajında
  "tool_calls": [ … ] }          // assistant mesajında
```

tool_calls / tool sonucu (OpenAI konvansiyonu — spec'te tiplenmemiş):
```jsonc
{ "role": "assistant", "content": null,
  "tool_calls": [ { "id": "call_abc", "type": "function",
    "function": { "name": "get_weather", "arguments": "{\"city\":\"Istanbul\"}" } } ] }  // arguments = JSON STRING
{ "role": "tool", "tool_call_id": "call_abc", "content": "{\"temp\":21}" }
```

tools[] tanımı (OpenAI function-calling konvansiyonu):
```jsonc
{ "type": "function",
  "function": { "name": "…", "description": "…", "parameters": { /* JSON Schema */ } } }
```

## 4. Streaming (SSE)
`stream:true` → 200 `Content-Type: text/event-stream`. Spec gövdeyi `type: string` bırakır;
`[DONE]`, delta, tool-call-delta yapıları **spec'te tanımsız** — OpenAI konvansiyonu:
```
data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```
- Tool-call delta: `delta.tool_calls[]` → `index`, `id`, `type:"function"`, `function.name`,
  `function.arguments` (parça parça birikir, index'e göre birleştir).
- `finish_reason`: spec enum vermez. OpenAI: `stop|length|tool_calls|content_filter`.
- **Usage/maliyet: response header'larından oku (gövdeye güvenme):**
  `X-OmniRoute-Tokens-In`, `X-OmniRoute-Tokens-Out`, `X-OmniRoute-Response-Cost` (USD),
  `X-OmniRoute-Model`, `X-OmniRoute-Provider`, `X-OmniRoute-Latency-Ms`, `X-OmniRoute-Cache-Hit`,
  `X-OmniRoute-Request-Id`. Her 200 yanıtında (stream + non-stream) var.

## 5. Non-streaming Response
```jsonc
{ "id": "…", "object": "chat.completion",
  "choices": [ { "index": 0, "message": { "role": "…", "content": "…", "tool_calls": [ … ] },
                 "finish_reason": "stop|tool_calls|…" } ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 } }
```
`message.tool_calls` spec'te tiplenmemiş ama tool çağrısında döner — defensive parse et.

## 6. GET /api/v1/models
`{ "object": "list", "data": [ Model, … ] }`. Gerçek Model (zengin):
```jsonc
{ "id": "auto/best-coding", "object": "model", "owned_by": "combo",
  "context_length": 1048576, "max_output_tokens": 512000,
  "capabilities": { "tool_calling": true, "reasoning": true, "thinking": true, "temperature": true } }
```
- `capabilities.tool_calling` ile tool-destekli modelleri filtrele. Örnekte 236 model.
- id biçimi `<provider-prefix>/<model>`. Örnekler: `auto/best-coding`, `auto/best-reasoning`,
  `cc/claude-opus-4-8`, `claude/claude-fable-5`, `cx/gpt-5.6-sol`, `aug/claude-haiku-4.5`.

## 7. Hata formatı (TUTARSIZ — iki biçimi de handle et)
- 401: `{ "error": "Unauthorized" }` — `error` DÜZ STRING.
- Diğer: `{ "error": { "message", "type", "details"? }, "requestId": "uuid" }` — `error` OBJE.
- Client: `typeof error === "string" ? error : error.message`. `error.code` YOK.
- Validation: `{ "error": { "message", "details": [ { "field", "message" } ] } }`.
- chat/completions `502`: "All upstream providers failed" (gövde şeması tanımsız).

## 8. Anthropic-uyumlu /api/v1/messages (alternatif, MVP dışı)
- Anthropic Messages formatı: `required: [model, messages, max_tokens]` (max_tokens zorunlu).
- `messages[].role` sadece `user|assistant`; system ayrı top-level `system: string`.
- Yine `Authorization: Bearer`. `/api/v1/messages/count_tokens` token sayımı sunar.
- MVP'de OpenAI endpoint'i (`/chat/completions`) kullanılır; bu not ileride native-Claude için.

## Client özet kararları
- Base `http://localhost:20128`, tüm çağrılar `Authorization: Bearer <key>`.
- Ana endpoint `POST /api/v1/chat/completions` (OpenAI şeması, `stream:true` SSE).
- Usage'ı `X-OmniRoute-*` header'larından al.
- Hata: hem string hem obje `error` biçimini destekle.
- Model listesi `GET /api/v1/models`, `capabilities.tool_calling` ile filtrele.
