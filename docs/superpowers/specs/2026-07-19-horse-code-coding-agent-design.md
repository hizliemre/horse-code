# horse-code — Terminal Coding Agent Tasarım Dokümanı

**Tarih:** 2026-07-19
**Durum:** Onaylandı, uygulamaya hazır
**Paket:** `horse-code` (npm) · **CLI komutu:** `hcode`

---

## 1. Amaç ve Kapsam

`horse-code`, terminalde çalışan, npm üzerinden kurulan, açık kaynak bir coding agent'tır.
LLM'e bir dış gateway servisi (**omniroute**) üzerinden bağlanır, tool-calling temelli bir
agent loop ile kod tabanı üzerinde okuma/yazma/çalıştırma işlemleri yapar.

**Ana hedef:** Açık kaynak ürün. Bu nedenle temiz katmanlı mimari, genişletilebilirlik ve
sıfır sürtünmeli kurulum (npx) önceliklidir.

### MVP'de VAR
- Tool-calling agent loop (LLM ↔ tool ↔ LLM), streaming, iptal (Esc)
- 7 tool: `read_file`, `grep`, `glob`, `web_search`/`fetch`, `write_file`, `edit_file`, `shell`
- 3 izin modu (`ask` / `acceptEdits` / `auto`) + allowlist
- omniroute provider (OpenAI-uyumlu `/chat/completions`, stream + tools)
- Katmanlı config (yerleşik → global → proje → env)
- jsonl session kaydı + `--resume`
- Ink/React TUI (streaming çıktı, diff görünümü, onay diyalogları)
- Slash komutları: `/model`, `/mode`

### MVP'de YOK (sonraya)
Otomatik context compaction/özetleme, MCP istemcisi, plugin/skill sistemi,
çoklu provider, sandboxing, sub-agent'lar, git worktree entegrasyonu.

---

## 2. Mimari — Katmanlar

Çekirdek, UI'dan tamamen ayrıktır. Core doğrudan UI'a yazmaz; bir **event stream** yayınlar,
UI bu event'lere abone olur. Böylece çekirdek headless test edilebilir ve UI değişse bozulmaz.

```
┌─────────────────────────────────────────┐
│  UI katmanı (Ink/React)                  │  ← sadece render + input
│  mesaj geçmişi, streaming, onay diyalog. │
├─────────────────────────────────────────┤
│  Core / Agent Engine (UI-agnostik)       │  ← agent loop'un kalbi
│  - konuşma döngüsü (LLM ↔ tool ↔ LLM)    │
│  - event emitter (UI buna abone olur)    │
├──────────┬──────────────┬───────────────┤
│ Provider │ Tool Registry│ Permission     │
│ (omniroute│ (read/write/ │ (modlar +      │
│  client) │  edit/shell/ │  allowlist)    │
│          │  grep/web)   │                │
├──────────┴──────────────┴───────────────┤
│  Config & Session (dosya, geçmiş, ayar)  │
└─────────────────────────────────────────┘
```

**Event tipleri (örnek):** `message.delta`, `message.done`, `tool.request`, `tool.result`,
`permission.ask`, `usage`, `error`, `abort`.

---

## 3. Agent Loop Akışı

```
kullanıcı mesajı
      │
      ▼
1. Mesajı history'e ekle
2. omniroute'a gönder (stream=true, tools=registry.schemas())
3. Yanıtı stream et → UI'a 'message.delta'
4. LLM tool çağırdı mı?
   ├─ Hayır → döngü biter, kullanıcıya dön
   └─ Evet ↓
5. Her tool_call için:
   a. Permission kontrol (mod + allowlist)
   b. Gerekiyorsa UI'dan onay iste ('permission.ask' → yanıt)
   c. Tool'u çalıştır
   d. Sonucu 'tool.result' ile history'e ekle
6. Adım 2'ye dön (LLM sonuçları görsün)
```

### Detaylar
- **Paralel tool çağrıları:** Bağımsız ve onaysız (safe) tool'lar paralel çalışır;
  onay gerektirenler sırayla sorulur.
- **İptal (Esc):** Core'a `AbortSignal` geçilir; hem stream'i hem çalışan tool'u iptal eder.
- **Hata dayanıklılığı:** Tool hatası loop'u çökertmez — hata, tool sonucu olarak LLM'e
  döner (`is_error: true`). Ağ/gateway hatalarında retry + kullanıcıya net mesaj.
- **Context yönetimi (MVP):** Token sayısı takip edilir; pencere dolmaya yaklaşınca
  kullanıcı uyarılır. Otomatik compaction MVP dışı.

---

## 4. Tool Registry & Permission

### Tool arayüzü
Her tool tek bir sözleşmeyi uygular; yeni tool eklemek = yeni dosya.

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;        // LLM'e gönderilen şema (zod'dan üretilir)
  permission: PermissionLevel;   // 'safe' | 'write' | 'exec'
  execute(args, ctx): AsyncIterable<ToolEvent> | Promise<ToolResult>;
}
```

### MVP tool'ları

| Tool | Seviye | Onay |
|------|--------|------|
| `read_file` | safe | onaysız |
| `grep` / `glob` | safe | onaysız |
| `web_search` / `fetch` | safe | onaysız |
| `write_file` / `edit_file` | write | diff göster + onay |
| `shell` | exec | komut göster + onay |

### Permission motoru — 3 mod (runtime'da `/mode` ile değişir)
- **`ask`** (varsayılan): her `write`/`exec` işleminde onay iste.
- **`acceptEdits`**: dosya düzenlemeleri otomatik, shell hâlâ sorar.
- **`auto`**: her şey otomatik (uyarıyla).

### Allowlist
Onay diyaloğunda "bu komuta hep izin ver" seçeneği kural olarak saklanır:
- Shell → komut prefix'i (ör. `npm test`, `git status`)
- Dosya → glob (ör. `src/**`)
- Session-scoped veya kalıcı (proje config'ine yazılır).

Akış event üzerinden: Core `permission.ask` yayınlar, UI diyalog gösterir, yanıt Core'a döner.

### Güvenlik
Shell komutları için kaba "tehlikeli desen" kontrolü (ör. `rm -rf /`, fork bomb) `auto`
modda bile uyarır. Derin sandboxing MVP dışı.

---

## 5. Provider (omniroute) & Config

### Provider soyutlaması
Core, omniroute'u değil bir `Provider` arayüzünü tanır:

```typescript
interface Provider {
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  // ChatEvent: text-delta | tool-call | usage | done | error
}
```

`OmniRouteProvider` bunu OpenAI-uyumlu `/chat/completions` (stream + tools) üstünden uygular.
Format farklı çıkarsa yalnızca bu dosya değişir; Core etkilenmez. İleride başka provider =
yeni bir sınıf.

> **Doğrulandı (2026-07-19):** omniroute OpenAI-uyumlu `POST /api/v1/chat/completions`
> sunuyor (tool calling + SSE streaming), auth `Authorization: Bearer <key>`, base
> `http://localhost:20128`. Usage/maliyet `X-OmniRoute-*` response header'larından okunur.
> Tam sözleşme: `docs/superpowers/reference/omniroute-api.md`. Sapma olursa yalnızca
> `OmniRouteProvider` etkilenir.

### Yapılandırma katmanları (üst alttakini ezer)
1. Yerleşik varsayılanlar (`baseUrl = http://localhost:20128`, `mode = ask`)
2. Global: `~/.horsecode/config.json` (API key, base URL, varsayılan model, mod)
3. Proje: `.horsecode/config.json` (repo'ya özel model/allowlist — **key TUTMAZ**)
4. Ortam değişkenleri (`OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`)

### API key & gizlilik
Key yalnızca global config veya env'de. Proje config'i key tutmaz (repo'ya sızmasın).
İlk çalıştırmada key yoksa kısa onboarding akışı.

### Session/geçmiş
Her oturum `.horsecode/sessions/<id>.jsonl` (mesajlar + tool sonuçları). MVP'de kayıt +
basit `--resume`.

### Model seçimi
`/model` ile oturum içinde değiştirilebilir; omniroute'un sunduğu modeller
(config listesi veya runtime sorgu).

---

## 6. Proje Yapısı & Paketleme

```
horse-code/
├── package.json          # bin: { "hcode": "./dist/cli.js" }, ESM
├── tsconfig.json
├── src/
│   ├── cli.tsx           # giriş: arg parse → UI mount
│   ├── core/
│   │   ├── engine.ts     # agent loop + event emitter
│   │   ├── session.ts    # history + jsonl kayıt
│   │   └── events.ts     # event tipleri
│   ├── providers/
│   │   └── omniroute.ts  # Provider impl
│   ├── tools/
│   │   ├── registry.ts
│   │   └── read.ts write.ts edit.ts shell.ts grep.ts glob.ts web.ts
│   ├── permission/
│   │   ├── engine.ts     # modlar + allowlist eşleştirme
│   │   └── rules.ts
│   ├── config/
│   │   └── config.ts     # katmanlı yükleme
│   └── ui/
│       ├── App.tsx        # ana Ink bileşeni, event'lere abone
│       ├── components/    # MessageList, Composer, PermissionDialog, DiffView...
│       └── hooks/
└── test/                  # core headless testleri (UI'sız)
```

### Teknoloji seçimleri
- **Dil:** TypeScript (ESM), Node ≥ 20
- **UI:** Ink 5 + React
- **Şema/doğrulama:** `zod` (tool şeması → JSON Schema)
- **Arg parse:** `commander` veya `yargs`
- **Test:** `vitest`
- **Build:** `tsup`/`esbuild`

### Test stratejisi
Core ve tool'lar UI'sız test edilir: mock Provider ile loop, gerçek FS tmp'de,
permission motoru saf birim testi. UI ayrıca event akışıyla test edilir. **TDD** ile gidilir.

---

## 7. Açık Sorular / Doğrulanacaklar
- ~~omniroute'un tam API sözleşmesi~~ → **Çözüldü (2026-07-19):** tam sözleşme
  `docs/superpowers/reference/omniroute-api.md`'de. Endpoint `POST /api/v1/chat/completions`,
  auth `Authorization: Bearer`, SSE streaming, `GET /api/v1/models` (capabilities.tool_calling
  filtresi). Not: spec `tool_calls`/SSE delta yapılarını tiplemez → OpenAI konvansiyonuyla
  defensive parse edilecek. Hata gövdesi tutarsız (401 string, diğerleri obje) → iki biçim de
  ele alınacak.

## 8. Uygulama Notları (Foundation diliminden)
- **Allowlist güvenliği:** `matchesAllowlist` eşleşme türünü (`glob`/`prefix`) çağırandan
  (engine, `PermissionLevel`'e göre) açıkça alır — string şeklinden tahmin etmez. Prefix
  (shell) modunda shell metakarakteri (`; & | \` $ ( ) { } < >` / newline) içeren komutlar
  hiçbir kurala eşleşmez; bu, `npm test && rm -rf ~` gibi zincirleme bypass'ını engeller.
  Dilim 2'nin shell tool'u bu garantiye güvenir.
- **Config dayanıklılığı:** dosya şeması `.strip()` kullanır (`.strict()` değil) — bir typo/
  bilinmeyen key yalnızca o alanı düşürür, tüm katmanı değil. Bilinmeyen key'ler zaten merge'e
  girmez (güvenlik `apiKey` ayıklamasıyla ayrıca sağlanır).
