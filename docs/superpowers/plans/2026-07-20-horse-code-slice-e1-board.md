# horse-code Dilim E1 — Board (Veri Modeli + Kalıcılık) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine'in tek doğruluk kaynağı (SoT) olan `Board`'u inşa etmek — kartlar (kolonlar, deps, reviewNotes, attempts, stageHistory audit trail), dumb mutasyon primitifleri, zod-doğrulamalı `toJSON`/`fromJSON`, ve `board.json` kalıcılığı; tamamen saf ve test edilebilir.

**Architecture:** `Board` mutable bir sınıf; iç durumu `Map<id, Card>` (ekleme sırası korunur). Mutasyonlar dumb — akış politikası dayatmaz (engine E4 sahiplenir). `get`/`list` savunmalı kopya döner. Serileştirme (`toJSON`/`fromJSON`) saf ve zod-doğrulamalı; `saveBoard`/`loadBoard` ince fs sarmalayıcıları (ayrı dosya). Yeni npm bağımlılığı yok (`zod` mevcut).

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod`, `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **Board dumb SoT:** `move` herhangi bir geçerli `Column`'a izin verir (akış geçerliliğini engine E4 sahiplenir). Board yalnızca durum + audit tutar.
- **Savunmalı kopya:** `get`/`list`/`byColumn`/`addCard` iç `Card`'ın kopyasını döner; iç durum yalnızca Board metotlarıyla değişir.
- **StageEvent'te timestamp YOK:** dizi sırası olay sırasını verir (deterministik test).
- **Kart alanları:** `{ id, title, column, worktree?, deps[], reviewNotes[], attempts, stageHistory[] }`. Yeni kart TODO'da, `attempts:0`, boş diziler.
- `toJSON`/`fromJSON` saf (fs'siz); `fromJSON` zod ile doğrular (geçersiz → hata). Board JSON: `{ version: 1, cards: Card[] }`.
- Test framework `vitest`; her task TDD (önce başarısız test). fs testleri `mkdtemp` tmp dizinde, `afterEach`'te silinir.

---

### Task 1: Tipler + Board Çekirdeği (addCard/get/list/byColumn)

**Files:**
- Create: `src/board/board.ts`
- Test: `test/board/board.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces:
  - `type Column`, `interface StageEvent`, `interface Card`, `interface BoardData` (export)
  - `class Board` — kurucu `(cards?: Card[])`; `addCard({id,title,deps?}): Card` (TODO, attempts 0, boş diziler; dup id → hata); `get(id): Card | undefined`; `list(): Card[]` (ekleme sırası); `byColumn(col): Card[]`. Hepsi savunmalı kopya.

- [ ] **Step 1: Başarısız testi yaz**

`test/board/board.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

describe("Board çekirdek", () => {
  it("addCard yeni kartı TODO'da, attempts 0, boş dizilerle ekler", () => {
    const b = new Board();
    const c = b.addCard({ id: "t1", title: "ilk", deps: ["x"] });
    expect(c).toEqual({
      id: "t1", title: "ilk", column: "TODO",
      deps: ["x"], reviewNotes: [], attempts: 0, stageHistory: [],
    });
  });

  it("aynı id ikinci kez → hata", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    expect(() => b.addCard({ id: "t1", title: "b" })).toThrow(/zaten var/);
  });

  it("get bilinmeyen id'de undefined döner", () => {
    expect(new Board().get("yok")).toBeUndefined();
  });

  it("list ekleme sırasını korur; byColumn filtreler", () => {
    const b = new Board();
    b.addCard({ id: "a", title: "a" });
    b.addCard({ id: "b", title: "b" });
    expect(b.list().map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("TODO").map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.byColumn("DONE")).toEqual([]);
  });

  it("get savunmalı kopya döner (dış mutasyon iç durumu bozmaz)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    const c = b.get("t1")!;
    c.reviewNotes.push("dışarıdan");
    c.column = "DONE";
    expect(b.get("t1")!.reviewNotes).toEqual([]);
    expect(b.get("t1")!.column).toBe("TODO");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/board/board.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/board/board.ts` yaz**

```typescript
export type Column = "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE";

export interface StageEvent {
  role: string;
  action: string;
  note?: string;
}

export interface Card {
  id: string;
  title: string;
  column: Column;
  worktree?: string;
  deps: string[];
  reviewNotes: string[];
  attempts: number;
  stageHistory: StageEvent[];
}

export interface BoardData {
  version: 1;
  cards: Card[];
}

function cloneCard(c: Card): Card {
  return {
    ...c,
    deps: [...c.deps],
    reviewNotes: [...c.reviewNotes],
    stageHistory: c.stageHistory.map((e) => ({ ...e })),
  };
}

export class Board {
  private cards = new Map<string, Card>();

  constructor(cards: Card[] = []) {
    for (const c of cards) this.cards.set(c.id, cloneCard(c));
  }

  addCard(input: { id: string; title: string; deps?: string[] }): Card {
    if (this.cards.has(input.id)) throw new Error(`kart zaten var: ${input.id}`);
    const card: Card = {
      id: input.id,
      title: input.title,
      column: "TODO",
      deps: input.deps ? [...input.deps] : [],
      reviewNotes: [],
      attempts: 0,
      stageHistory: [],
    };
    this.cards.set(card.id, card);
    return cloneCard(card);
  }

  get(id: string): Card | undefined {
    const c = this.cards.get(id);
    return c ? cloneCard(c) : undefined;
  }

  list(): Card[] {
    return [...this.cards.values()].map(cloneCard);
  }

  byColumn(column: Column): Card[] {
    return this.list().filter((c) => c.column === column);
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/board/board.test.ts && npm run typecheck`
Expected: PASS; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/board/board.ts test/board/board.test.ts
git commit -m "feat: Board çekirdeği (Card/StageEvent tipleri + addCard/get/list/byColumn)"
```

---

### Task 2: Board Mutasyonları

**Files:**
- Modify: `src/board/board.ts` (mutasyon metotları + private `require`)
- Test: `test/board/mutations.test.ts`

**Interfaces:**
- Consumes: `Board`, `Card`, `Column`, `StageEvent` (Task 1)
- Produces (Board metotları):
  - `move(id, column, actor?)` — kolonu değiştirir; `actor` verilirse `{role:actor, action:`→${column}`}` stage'i ekler.
  - `appendStage(id, event)`; `addReviewNote(id, note)`; `clearReviewNotes(id)`; `incrementAttempts(id): number`; `setWorktree(id, path)`. Hepsi bilinmeyen id'de hata.

- [ ] **Step 1: Başarısız testi yaz**

`test/board/mutations.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

function seeded(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "a" });
  return b;
}

describe("Board mutasyonları", () => {
  it("move kolonu değiştirir; actor'lı stage event ekler", () => {
    const b = seeded();
    b.move("t1", "IN-PROGRESS", "team-lead");
    const c = b.get("t1")!;
    expect(c.column).toBe("IN-PROGRESS");
    expect(c.stageHistory).toEqual([{ role: "team-lead", action: "→IN-PROGRESS" }]);
  });

  it("move actor'sız stage event eklemez", () => {
    const b = seeded();
    b.move("t1", "REVIEW");
    expect(b.get("t1")!.stageHistory).toEqual([]);
    expect(b.get("t1")!.column).toBe("REVIEW");
  });

  it("appendStage zengin event ekler", () => {
    const b = seeded();
    b.appendStage("t1", { role: "code-reviewer", action: "reviewed:fail", note: "x" });
    expect(b.get("t1")!.stageHistory).toEqual([
      { role: "code-reviewer", action: "reviewed:fail", note: "x" },
    ]);
  });

  it("addReviewNote / clearReviewNotes", () => {
    const b = seeded();
    b.addReviewNote("t1", "n1");
    b.addReviewNote("t1", "n2");
    expect(b.get("t1")!.reviewNotes).toEqual(["n1", "n2"]);
    b.clearReviewNotes("t1");
    expect(b.get("t1")!.reviewNotes).toEqual([]);
  });

  it("incrementAttempts yeni değeri döner", () => {
    const b = seeded();
    expect(b.incrementAttempts("t1")).toBe(1);
    expect(b.incrementAttempts("t1")).toBe(2);
    expect(b.get("t1")!.attempts).toBe(2);
  });

  it("setWorktree yolu set eder", () => {
    const b = seeded();
    b.setWorktree("t1", "/wt/t1");
    expect(b.get("t1")!.worktree).toBe("/wt/t1");
  });

  it("bilinmeyen id her mutasyonda hata verir", () => {
    const b = seeded();
    expect(() => b.move("yok", "DONE")).toThrow(/bilinmeyen kart/);
    expect(() => b.appendStage("yok", { role: "r", action: "a" })).toThrow(/bilinmeyen kart/);
    expect(() => b.addReviewNote("yok", "n")).toThrow(/bilinmeyen kart/);
    expect(() => b.incrementAttempts("yok")).toThrow(/bilinmeyen kart/);
    expect(() => b.setWorktree("yok", "/p")).toThrow(/bilinmeyen kart/);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/board/mutations.test.ts`
Expected: FAIL — `move` yok.

- [ ] **Step 3: `src/board/board.ts`'e ekle**

`byColumn`'dan SONRA, sınıf içine private helper + mutasyonları ekle:
```typescript
  private require(id: string): Card {
    const c = this.cards.get(id);
    if (!c) throw new Error(`bilinmeyen kart: ${id}`);
    return c;
  }

  move(id: string, column: Column, actor?: string): void {
    const c = this.require(id);
    c.column = column;
    if (actor) c.stageHistory.push({ role: actor, action: `→${column}` });
  }

  appendStage(id: string, event: StageEvent): void {
    this.require(id).stageHistory.push({ ...event });
  }

  addReviewNote(id: string, note: string): void {
    this.require(id).reviewNotes.push(note);
  }

  clearReviewNotes(id: string): void {
    this.require(id).reviewNotes = [];
  }

  incrementAttempts(id: string): number {
    const c = this.require(id);
    c.attempts += 1;
    return c.attempts;
  }

  setWorktree(id: string, path: string): void {
    this.require(id).worktree = path;
  }
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/board/mutations.test.ts && npm run typecheck`
Expected: PASS (tüm alt testler); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/board/board.ts test/board/mutations.test.ts
git commit -m "feat: Board mutasyonları (move/appendStage/reviewNotes/attempts/worktree)"
```

---

### Task 3: toJSON / fromJSON (zod-doğrulamalı serileştirme)

**Files:**
- Modify: `src/board/board.ts` (`zod` import + şema + iki metot)
- Test: `test/board/serialize.test.ts`

**Interfaces:**
- Consumes: `Board`, `BoardData` (Task 1)
- Produces:
  - `toJSON(): BoardData` — `{ version: 1, cards: list() }`.
  - `static fromJSON(data: unknown): Board` — zod ile doğrular (geçersiz → hata), doğrulanmış kartlarla `Board` kurar.

- [ ] **Step 1: Başarısız testi yaz**

`test/board/serialize.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";

describe("Board serileştirme", () => {
  it("toJSON version + kartları verir", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a" });
    b.move("t1", "REVIEW", "coder");
    const data = b.toJSON();
    expect(data.version).toBe(1);
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0].column).toBe("REVIEW");
  });

  it("toJSON → fromJSON round-trip aynı kartları verir", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", deps: ["x"] });
    b.addReviewNote("t1", "n");
    b.incrementAttempts("t1");
    const back = Board.fromJSON(b.toJSON());
    expect(back.list()).toEqual(b.list());
  });

  it("fromJSON geçersiz veride hata verir", () => {
    expect(() => Board.fromJSON({ version: 1, cards: [{ id: "t1" }] })).toThrow();
    expect(() => Board.fromJSON({ version: 2, cards: [] })).toThrow();
    expect(() =>
      Board.fromJSON({ version: 1, cards: [{ id: "a", title: "a", column: "BOGUS", deps: [], reviewNotes: [], attempts: 0, stageHistory: [] }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/board/serialize.test.ts`
Expected: FAIL — `toJSON` yok.

- [ ] **Step 3: `src/board/board.ts`'e ekle**

Dosyanın başına import ekle:
```typescript
import { z } from "zod";
```

`cloneCard`'ın ÜSTÜNE şemaları ekle:
```typescript
const stageEventSchema = z.object({
  role: z.string(),
  action: z.string(),
  note: z.string().optional(),
});
const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  column: z.enum(["TODO", "IN-PROGRESS", "REVIEW", "DONE"]),
  worktree: z.string().optional(),
  deps: z.array(z.string()),
  reviewNotes: z.array(z.string()),
  attempts: z.number(),
  stageHistory: z.array(stageEventSchema),
});
const boardDataSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) });
```

`Board` sınıfına (mutasyonlardan sonra) iki metodu ekle:
```typescript
  toJSON(): BoardData {
    return { version: 1, cards: this.list() };
  }

  static fromJSON(data: unknown): Board {
    const parsed = boardDataSchema.parse(data);
    return new Board(parsed.cards);
  }
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/board/serialize.test.ts && npm run typecheck`
Expected: PASS (3 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/board/board.ts test/board/serialize.test.ts
git commit -m "feat: Board toJSON/fromJSON (zod-doğrulamalı serileştirme)"
```

---

### Task 4: Kalıcılık (saveBoard / loadBoard)

**Files:**
- Create: `src/board/persist.ts`
- Test: `test/board/persist.test.ts`

**Interfaces:**
- Consumes: `Board` (`./board.js`)
- Produces:
  - `saveBoard(board: Board, path: string): Promise<void>` — üst dizini oluşturur, `board.toJSON()`'ı pretty JSON olarak yazar.
  - `loadBoard(path: string): Promise<Board>` — dosyayı okur, `Board.fromJSON` ile doğrular.

- [ ] **Step 1: Başarısız testi yaz**

`test/board/persist.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../../src/board/board.js";
import { saveBoard, loadBoard } from "../../src/board/persist.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-board-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("board kalıcılığı", () => {
  it("saveBoard üst dizini oluşturur ve loadBoard aynı board'u döner", async () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "a", deps: ["x"] });
    b.move("t1", "REVIEW", "coder");
    b.addReviewNote("t1", "n");
    const path = join(dir, "sessions", "s1", "board.json"); // üst dizinler yok
    await saveBoard(b, path);
    expect(existsSync(path)).toBe(true);
    const back = await loadBoard(path);
    expect(back.list()).toEqual(b.list());
  });

  it("var olmayan dosyada loadBoard hata verir", async () => {
    await expect(loadBoard(join(dir, "yok.json"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/board/persist.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/board/persist.ts` yaz**

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Board } from "./board.js";

export async function saveBoard(board: Board, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(board.toJSON(), null, 2), "utf8");
}

export async function loadBoard(path: string): Promise<Board> {
  const raw = await readFile(path, "utf8");
  return Board.fromJSON(JSON.parse(raw));
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/board/persist.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/board/persist.ts test/board/persist.test.ts
git commit -m "feat: board.json kalıcılığı (saveBoard/loadBoard)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D + E1)
- [ ] `git log --oneline` — bu dilimde 4 commit

Bu dilim şunu teslim eder: engine'in SoT'u `Board` — kartlar, dumb mutasyonlar, audit trail, zod-doğrulamalı serileştirme ve `board.json` kalıcılığı. Sonraki alt-dilim **E0 (structured role output)** bağımsızdır; **E2 (project-manager + team-lead)** Board'a kart yazacak; **E4 (dalga motoru)** Board'u SoT olarak sürecek.

## Kapsam Dışı (bilinçli — sonraki alt-dilimler)

- Engine akış mantığı / geçerli geçiş dizisi / dalgalar / escalation → E4. Board dumb SoT.
- role-agent'lar (project-manager/team-lead/coder/reviewer) → E2/E3.
- StageEvent timestamp (enjekte clock) → gerekirse ileride.
- Board UI → MVP dışı.
