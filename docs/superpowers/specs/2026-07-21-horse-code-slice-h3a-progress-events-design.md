# horse-code Dilim H3a — İlerleme Event'leri Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** H3 (TUI). H3a = ilerleme event altyapısı (Ink-siz, testlenebilir); H3b = Ink UI.

---

## 1. Amaç ve Kapsam

`runJob` şu an sessiz (pipeline'ı koşup sonunda `JobResult` döner). Canlı bir UI için **ilerleme
event'leri** gerekir. H3a: `Board`'ı gözlemlenebilir yapar + `runJob`'a opsiyonel `onEvent` seam'i
ekler → faz geçişleri ve board değişiklikleri yayılır. UI (Ink veya başka) H3b'de tüketir.

**Tüketir (tamam):** E1 `Board`/`Column`; H1 `runJob`/`JobDeps`/`JobResult`; G2 revision entegrasyonu.

Konum: `src/board/board.ts` (`onChange`); `src/engine/progress.ts` (`ProgressEvent` + helper);
`src/engine/job.ts` (`onEvent` + emisyonlar).

### Kapsam DIŞI (H3a değil)
- **Ink TUI / render** → H3b.
- **Fine upstream alt-fazları** (council/judge/spec/plan tek tek) — H3a kaba faz yayınlar; board
  gözlemcisi task-seviyesini otomatik verir. Daha ince event'ler ileride threading ile.
- **Gerçek terminal render** → H3b (H3a yalnız event üretir).

---

## 2. `Board` Gözlemci (`board.ts`)

`Board`'a opsiyonel, settable bir alan:

```typescript
export class Board {
  onChange?: () => void;   // her mutation sonrası çağrılır (varsa)
  ...
}
```

Mutation metodlarının (`addCard`, `move`, `appendStage`, `addReviewNote`, `clearReviewNotes`,
`incrementAttempts`, `setWorktree`) **sonunda** `this.onChange?.()` çağrılır. Böylece dalga/revision
içindeki derin board değişiklikleri (task kolonları, stageHistory) `onEvent`'e her yere threading
gerekmeden ulaşır.

> E1 "dumb SoT" korunur: mutasyon mantığı değişmez, yalnız değişiklik sonrası bir bildirim eklenir.
> `onChange` opsiyonel/tanımsız (varsayılan) → mevcut davranış aynen (geriye dönük uyumlu; `toJSON`/
> `fromJSON`/defensive-copy etkilenmez, `onChange` serileştirilmez).

---

## 3. `ProgressEvent` (`progress.ts`)

```typescript
import type { Board, Column } from "../board/board.js";

export interface BoardCardView { id: string; title: string; column: Column }

export type ProgressEvent =
  | { kind: "phase"; phase: string; detail?: string }   // upstream/chat/rejected/approved/board/waves/waves-done/pr/revision/revision-done/report/done
  | { kind: "board"; cards: BoardCardView[] };

export function snapshotBoard(board: Board): BoardCardView[] {
  return board.list().map((c) => ({ id: c.id, title: c.title, column: c.column }));
}
```

`phase` serbest string (UI bilinen fazları eşler); `detail` opsiyonel (intent, task sayısı, wave
status, PR url, revision status).

---

## 4. `runJob` — `onEvent` Emisyonları (`job.ts`)

`runJob` opts kazanır `onEvent?: (ev: ProgressEvent) => void`. `const emit = opts.onEvent ?? (() => {})`.

```
emit({ kind:"phase", phase:"upstream" })
up = await runUpstream(...)
if up.kind === "chat":    emit({phase:"chat"});               closeSession; return chat
if up.kind === "rejected": emit({phase:"rejected", detail: up.stage}); closeSession; return rejected
emit({phase:"approved"})
commitMerge(...)

emit({phase:"board"})
board = await runProjectManager(...)                // PM board'u içeride kurar (addCard'lar gözlemsiz)
emit({kind:"board", cards: snapshotBoard(board)})   // ilk board anlık görüntüsü
board.onChange = () => emit({kind:"board", cards: snapshotBoard(board)})   // sonraki mutasyonlar (waves/revision)

emit({phase:"waves"})
wave = await runWaves(...)                           // board mutasyonları emit eder
emit({phase:"waves-done", detail: wave.status})

if wave.status === "completed":
   emit({phase:"pr", detail: wave.pr.url})
   prDiff = await deps.manager.diff(...)
   emit({phase:"revision"})
   revision = await runRevision(...)                 // revision kartı + stage'ler emit eder
   emit({phase:"revision-done", detail: revision.status})

emit({phase:"report"})
report = await runCoachReport(...)
emit({phase:"done"})
return { kind:"done", wave, revision, report, session }
```

- **Board gözlemcisi** PM sonrası kurulur → dalga ve revision içi task/kart değişiklikleri task-seviyesi
  ilerleme verir (deep threading yok).
- **Emit no-op default:** `onEvent` verilmezse (headless/H2/testler) hiçbir şey değişmez.
- **Abort/hata:** emisyon `runJob`'un mevcut akışını değiştirmez (try/catch eklenmez); event'ler
  yalnız gözlem.

---

## 5. Test Stratejisi

İçerik-provider (H1/G2 jobProvider) + gerçek tmp git + bare remote + **event toplayıcı** `onEvent`.

- **Board.onChange:** `board.onChange = spy; board.addCard(...); board.move(...)` → spy her mutasyonda çağrıldı.
- **runJob done event sırası:** `onEvent` topla → `phase` event'leri sırayla `["upstream","approved",
  "board","waves","waves-done","pr","revision","revision-done","report","done"]` içerir; en az bir
  `{kind:"board"}` event'i var; board event kartlarının kolonları DONE'a ilerler.
- **chat:** `["upstream","chat"]`.
- **rejected:** `["upstream","rejected"]` (+ detail=stage).
- **onEvent'siz:** runJob normal çalışır (mevcut testler değişmez).

Tümü `vitest`, TDD; mevcut job.test infra + event collector.

---

## 6. H3a DIŞI (bilinçli ertelenen)

- **Ink TUI + render + Q&A input'ları** → H3b.
- **Fine upstream event'leri** (council üye üye, judge kararı, spec/plan yazımı adım adım) → ileride.
- **Event throttle/dedupe** (UI tarafında) → H3b.

---

## 7. Açık Noktalar / İleride

- `onChange` her mutasyonda çağrılır (appendStage dahil) → gürültülü olabilir; UI (H3b) board
  snapshot'tan render edip React ile dedupe eder.
- Upstream (F) kaba tek faz ("approved" öncesi) — spec/plan/council/judge ilerlemesi H3a'da görünmez;
  ileride runUpstream'e onEvent threading eklenebilir.
- `emit` senkron çağrılır; UI event handler'ı ağır iş yapmamalı (H3b React state günceller).
