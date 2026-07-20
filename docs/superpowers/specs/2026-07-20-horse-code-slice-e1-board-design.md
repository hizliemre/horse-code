# horse-code Dilim E1 — Board (Veri Modeli + Kalıcılık) Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§9 board & kart veri modeli)

---

## 1. Amaç ve Kapsam

Dilim **E** (Board engine + coding mechanism) sistemin kalbidir ve tek dilime sığmaz; alt-dilimlere
bölünmüştür:

| Alt-dilim | İçerik |
|-----------|--------|
| **E0** | Structured role output (role-agent loop'a şema-doğrulamalı çıktı) |
| **E1 → BU DOKÜMAN** | **Board — veri modeli + kalıcılık** (saf durum, role-agent yok) |
| E2 | project-manager + team-lead (plan→kart, deps→dalgalar) |
| E3 | Task yürütme + escalation (coder/reviewer/senior-coder/konsey) |
| E4 | Dalga motoru + entegrasyon (waves, wave-merge, conflict-council, PR) |

Bu doküman **E1**'i tanımlar: engine'in **tek doğruluk kaynağı (SoT)** olan `Board` — kartlar,
kolonlar, geçiş kaydı (audit trail) ve `board.json` kalıcılığı. Board **dumb** bir durum kabıdır;
akış mantığını (hangi geçiş ne zaman) engine (E4) sahiplenir.

**Tüketir:** yalnızca `zod` (JSON doğrulama) ve dosya sistemi. Role-agent/worktree/git YOK.

---

## 2. Veri Modeli (design doc §9)

```typescript
export type Column = "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE";

export interface StageEvent {
  role: string;    // coder | code-reviewer | senior-coder | team-lead | ...
  action: string;  // "→REVIEW" | "reviewed:fail" | "escalated" | ...
  note?: string;
}

export interface Card {
  id: string;
  title: string;
  column: Column;
  worktree?: string;          // D task worktree yolu (deriveTask'ta set edilir)
  deps: string[];             // bağımlı olduğu kart id'leri (team-lead dalgaları buradan çıkarır)
  reviewNotes: string[];      // reviewer notları; coder yeni-vs-dönen ayrımını buradan yapar
  attempts: number;           // escalation merdiveni sayacı
  stageHistory: StageEvent[]; // audit trail; coach final raporu bundan türetir
}
```

- **StageEvent'te timestamp YOK:** dizi sırası olay sırasını verir; testler deterministik kalır.
  Wall-clock timestamp gerekirse ileride enjekte edilebilir clock ile eklenir (E1 dışı).

---

## 3. `Board` Sınıfı

Mutable sınıf; engine'in SoT'u. Primitifler dumb — akış politikası dayatmaz.

```typescript
export class Board {
  constructor(cards?: Card[]);

  addCard(input: { id: string; title: string; deps?: string[] }): Card;
  // TODO kolonunda, attempts 0, reviewNotes [], stageHistory [] ile yeni kart. Var olan id → hata.

  get(id: string): Card | undefined;
  list(): Card[];                       // ekleme sırası korunur
  byColumn(column: Column): Card[];

  move(id: string, column: Column, actor?: string): void;
  // Kolonu değiştirir. actor verilirse stageHistory'e { role: actor, action: `→${column}` } ekler.
  // Bilinmeyen id → hata. (Kolon TS union; runtime doğrulama fromJSON'da.)

  appendStage(id: string, event: StageEvent): void;   // zengin audit event'i (ör. reviewed:fail)
  addReviewNote(id: string, note: string): void;      // reviewNotes'a ekler
  clearReviewNotes(id: string): void;                 // engine (E3) coder notları giderince çağırır
  incrementAttempts(id: string): number;              // ++attempts, yeni değeri döner
  setWorktree(id: string, path: string): void;

  toJSON(): BoardData;                  // { version: 1, cards: Card[] } — serileştirilebilir kopya
  static fromJSON(data: unknown): Board; // zod-doğrulamalı; geçersiz → hata
}

export interface BoardData { version: 1; cards: Card[] }
```

**Transition policy (kritik):** `move` **herhangi bir geçerli `Column`'a** izin verir (TODO→REVIEW
gibi "atlamalar" dahil). Board yalnızca durumu + audit'i tutar; geçerli akışı (TODO→IN-PROGRESS→
REVIEW→DONE, REVIEW→TODO) **engine (E4) sahiplenir.** Bu, design doc'un "engine deterministik olarak
geçişleri sahiplenir" kararıyla uyumludur — Board dumb SoT.

**Mutasyon güvenliği:** `get`/`list` dış mutasyona karşı savunmalı kopya döner (iç durum yalnızca
Board metotlarıyla değişir).

---

## 4. Kalıcılık

```typescript
export function saveBoard(board: Board, path: string): Promise<void>;  // board.toJSON() → dosya (pretty JSON)
export function loadBoard(path: string): Promise<Board>;               // dosya → Board.fromJSON (doğrulamalı)
```

- Konum: `.horsecode/sessions/<sessionId>/board.json` (design doc §9; yol çağırandan gelir).
- Format: `{ version: 1, cards: Card[] }`. Yükleme zod ile doğrulanır (bozuk/eksik alan → net hata).
- `toJSON`/`fromJSON` **saf** (fs'siz); `saveBoard`/`loadBoard` ince fs sarmalayıcıları.
- `saveBoard` üst dizini oluşturur (`mkdir -p`).

---

## 5. Test Stratejisi

- **Board birim testleri (saf, fs'siz):** addCard (yeni kart TODO'da; dup id → hata); move (kolon +
  actor'lı stage event); appendStage; addReviewNote/clearReviewNotes; incrementAttempts (dönen değer);
  setWorktree; byColumn/list sırası; bilinmeyen id → hata; get/list savunmalı kopya (dış mutasyon iç
  durumu bozmaz).
- **toJSON/fromJSON round-trip:** bir board → toJSON → fromJSON → aynı kartlar; bozuk JSON → hata.
- **Persistence (tmp fs):** `saveBoard` → dosya oluşur (üst dizin dahil) → `loadBoard` → aynı board;
  var olmayan dosya → net hata.
- Tümü `vitest`, TDD. fs testleri `mkdtemp` tmp dizinde, `afterEach`'te silinir.

---

## 6. E1 DIŞI (bilinçli ertelenen)

- **Engine akış mantığı** (geçerli geçiş dizisi, dalgalar, escalation) → E4. Board yalnızca durum.
- **role-agent'lar** (project-manager/team-lead/coder/reviewer) → E2/E3.
- **Board UI** → MVP dışı.
- **StageEvent timestamp** (enjekte clock) → gerekirse ileride.
- **structured output** (E0) — E1 role-agent tüketmez, gerekmez.

---

## 7. Açık Noktalar / İleride

- `reviewNotes` "cari tur outstanding notları" mı yoksa "tüm geçmiş" mi — E1 append + clear primitifi
  verir; **politikayı E3 seçer** (coder notları giderince clear vs biriktir). Board dayatmaz.
- Board versiyonlama (`version: 1`) — şema değişirse migration; E1'de yalnızca alan mevcut.
