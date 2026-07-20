# horse-code Dilim E2 — project-manager + team-lead Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.2 akış, §9 board)

---

## 1. Amaç ve Kapsam

Planı çalıştırılabilir bir board'a dönüştürmek: **project-manager** (role-agent) planı task
kartlarına böler ve Board'a yazar; **team-lead** (hibrit role) kartların bağımlılık grafiğinden
**dalgaları** çıkarır — önce deterministik hesaplar, sonra LLM ile teyit eder. E3 bu dalgaları/kartları
tüketip coder/designer/reviewer'ı koşturur.

**Tüketir (tamam):** E0 — `runStructuredRole` (`src/agent/structured.js`); E1 — `Board`
(`src/board/board.js`); C — `RoleAgentOptions` (`src/agent/loop.js`); `zod`.

Yeni orkestrasyon dizini: `src/engine/`.

---

## 2. Birimler

```
src/engine/waves.ts        → computeWaves(board), validateWaves(waves, board)   (saf)
src/engine/project-manager.ts → TasksSchema + runProjectManager(opts)
src/engine/team-lead.ts    → WavesSchema + runTeamLead(opts, board)
```

---

## 3. Deterministik Çekirdek (`src/engine/waves.ts`)

```typescript
export function computeWaves(board: Board): string[][];
export function validateWaves(waves: string[][], board: Board): boolean;
```

- **`computeWaves`** — topolojik katmanlama (Kahn): tekrar tekrar, `deps`'i tümü önceki dalgalarda
  yer almış kartları bir sonraki dalgaya al. Bir adımda hiçbir kart alınamıyor ama kart kaldıysa →
  **hata** (`bağımlılık döngüsü veya çözülemeyen bağımlılık`). Dalga içi sıra = kartların
  ekleme sırası (`board.list()`). Bağımsız kartlar aynı dalgada (paralel).
- **`validateWaves`** — verilen dalgalar geçerli mi: (a) her kart **tam bir kez** var; (b) her
  dalgadaki task'ın tüm `deps`'i **önceki** dalgalarda yer almış. `boolean` döner (fırlatmaz).

> Not: dangling dep (var olmayan id'ye referans) `computeWaves`'te de "çözülemeyen bağımlılık"
> olarak yakalanır; ama project-manager kartları zaten dep-bütünlüğü doğrulanmış üretir (§4).

---

## 4. project-manager (`src/engine/project-manager.ts`)

```typescript
export const TasksSchema: z.ZodType<{ tasks: { id: string; title: string; deps: string[] }[] }>;
export async function runProjectManager(opts: RoleAgentOptions): Promise<Board>;
```

- `opts.messages` içinde **plan** bulunur (çağıran koyar). `runStructuredRole(opts, TasksSchema)`
  ile `{ tasks }` üretilir.
- **`TasksSchema` `.superRefine` ile dep-bütünlüğünü doğrular:** tekrarlı id → hata; var olmayan
  id'ye referans veren dep → hata. Bu, E0'ın submit-retry'ı sayesinde **project-manager'ı kendini
  düzeltir kılar** (geçersiz graf → submit `isError` → model düzeltir).
- Doğrulanmış `tasks` ile yeni bir **`Board`** kurulur (`addCard({id, title, deps})`) ve döner.
- **Routing yok:** task `{id, title, deps}` minimal; coder-vs-designer kararı E3'ün (E2 etiket taşımaz).

---

## 5. team-lead (`src/engine/team-lead.ts`) — hibrit

```typescript
export const WavesSchema: z.ZodType<{ waves: string[][] }>;   // yalnızca şekil
export async function runTeamLead(opts: RoleAgentOptions, board: Board): Promise<string[][]>;
```

Akış:
1. **Deterministik taban:** `suggested = computeWaves(board)`.
2. **LLM teyit:** `runTeamLead`, board kartlarını (id, title, deps) + `suggested` dalgaları bir
   kullanıcı mesajı olarak `opts.messages`'e ekler ("bu dalgaları teyit et/gerekiyorsa düzelt");
   `runStructuredRole(opts', WavesSchema)` → `{ waves }`.
3. **Doğrula + fallback:** `validateWaves(waves, board)` →
   - **geçerli** → LLM dalgalarını kullan (teyit/düzeltme kabul).
   - **geçersiz** → deterministik `suggested`'ı kullan. **Deterministik taban otoritedir; LLM teyit
     eder ama bozamaz** (kullanıcı kararı: "önce deterministik, sonra LLM teyit").
4. Seçilen dalgaları (`string[][]`) döner.

> `WavesSchema` yalnızca `{waves: string[][]}` şeklini doğrular; anlamsal geçerlilik (`validateWaves`)
> board gerektirdiğinden şemada değil, post-check'te yapılır (fallback ile).

---

## 6. Veri Akışı

```
plan (planner çıktısı) → opts.messages
   │
runProjectManager(opts) → runStructuredRole(TasksSchema, dep-refine self-correct)
   → Board { kart: {id, title, deps} }
   │
runTeamLead(opts, board):
   suggested = computeWaves(board)         (deterministik)
   → runStructuredRole(WavesSchema) [kartlar + suggested prompt'ta]  (LLM teyit)
   → validateWaves(llmWaves, board) ? llmWaves : suggested
   → string[][] (dalgalar)
   │
E3/E4: dalgaları çalıştır (coder/designer per task, wave-merge, ...)
```

---

## 7. Test Stratejisi

- **computeWaves (saf):** bağımsız kartlar tek dalgada; zincir (a→b→c) sıralı dalgalar; elmas (a→{b,c}→d); döngü → hata; boş board → boş dalgalar.
- **validateWaves (saf):** geçerli dalga true; eksik/tekrar kart false; dep önceki dalgada değilse false.
- **runProjectManager (MockProvider):** submit ile `{tasks}` → Board kartları doğru; geçersiz graf (dangling dep) submit'i → superRefine isError → sonraki submit düzeltilmiş → Board (self-correct).
- **runTeamLead (MockProvider):** LLM geçerli dalga döndürünce onu kullanır; geçersiz döndürünce deterministik `suggested`'a düşer; istekte board+suggested prompt'ta.
- Tümü `vitest`, TDD, MockProvider ile ağsız.

---

## 8. E2 DIŞI (bilinçli ertelenen)

- **coder/designer/reviewer yürütme + escalation merdiveni** → E3.
- **Dalga motoru** (dalgaları gerçekten çalıştırma, task worktree türetme, wave-merge, PR) → E4.
- **Gerçek PM/team-lead prompt içerikleri** → F/G (E2'de yer-tutucu/config'ten).
- **coder-vs-designer routing** → E3.
- **team-lead'in daha zengin kararları** (paralellik limiti, önceliklendirme) → gerekirse ileride; E2 çekirdeği teyit/düzelt.

---

## 9. Açık Noktalar / İleride

- team-lead LLM'i `suggested`'ı reddedip geçersiz bir şey üretirse deterministik fallback devreye
  girer — bu davranış loglanabilir (audit); E2'de sessiz fallback, ileride event.
- Board id üretimi LLM'de (`t1`...); iki farklı session board'u karışmaz (her session kendi board'u, E1).
- Çok büyük plan → çok task → prompt bütçesi; compaction MVP dışı.
