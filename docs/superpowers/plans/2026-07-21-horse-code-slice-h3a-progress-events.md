# Dilim H3a — İlerleme Event'leri Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canlı UI için event altyapısı: `Board.onChange` gözlemci + `ProgressEvent` + `runJob` `onEvent` emisyonları (faz + board).

**Architecture:** `Board`'a opsiyonel `onChange` (mutation sonrası çağrılır) → derin board değişiklikleri threading-siz yayılır. `progress.ts` event tipleri + `snapshotBoard`. `runJob` opts.onEvent'e faz sınırlarında yayınlar + PM sonrası board.onChange kurar.

**Tech Stack:** TypeScript ESM, vitest. Yeni bağımlılık yok.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; mevcut job.test infra (jobProvider + gerçek git + bare remote) + event collector.
- **Geriye dönük uyum:** `onChange`/`onEvent` opsiyonel; verilmezse mevcut davranış aynen (mevcut tüm testler yeşil kalır). `Board.onChange` serileştirilmez (toJSON/fromJSON etkilenmez).
- **Dumb SoT korunur:** mutasyon mantığı değişmez, yalnız sona `this.onChange?.()` eklenir.

---

### Task 1: `Board.onChange` gözlemci

**Files:**
- Modify: `src/board/board.ts`
- Test: `test/board/board.test.ts`

**Interfaces:**
- Produces: `Board.onChange?: () => void` — `addCard`/`move`/`appendStage`/`addReviewNote`/`clearReviewNotes`/`incrementAttempts`/`setWorktree` sonunda çağrılır.

- [ ] **Step 1: Kırmızı test**

`test/board/board.test.ts`'e ekle:

```typescript
  it("onChange her mutasyonda çağrılır", () => {
    const b = new Board();
    let calls = 0;
    b.onChange = () => { calls++; };
    b.addCard({ id: "t1", title: "X" });               // 1
    b.move("t1", "IN-PROGRESS");                        // 2
    b.appendStage("t1", { role: "r", action: "a" });   // 3
    b.addReviewNote("t1", "n");                         // 4
    b.clearReviewNotes("t1");                           // 5
    b.incrementAttempts("t1");                          // 6
    b.setWorktree("t1", "/w");                          // 7
    expect(calls).toBe(7);
  });

  it("onChange yoksa mutasyon normal çalışır (geriye uyumlu)", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "X" });
    b.move("t1", "DONE");
    expect(b.get("t1")!.column).toBe("DONE");
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/board/board.test.ts`
Expected: FAIL — `onChange` yok (calls 0).

- [ ] **Step 3: Board.onChange implement**

`src/board/board.ts` — `class Board`'a alan ekle (`private cards` üstüne veya altına):

```typescript
  onChange?: () => void;
```

Her mutasyon metodunun **sonuna** `this.onChange?.();` ekle:

- `addCard`: `this.cards.set(card.id, card);` sonrası, `return cloneCard(card);` ÖNCESİ → `this.onChange?.();`
- `move`: metod sonuna `this.onChange?.();`
- `appendStage`: `this.require(id).stageHistory.push({ ...event });` sonrası → `this.onChange?.();`
- `addReviewNote`: push sonrası → `this.onChange?.();`
- `clearReviewNotes`: atama sonrası → `this.onChange?.();`
- `incrementAttempts`: `c.attempts += 1;` sonrası, `return c.attempts;` ÖNCESİ → `this.onChange?.();`
- `setWorktree`: atama sonrası → `this.onChange?.();`

Örnek (addCard):

```typescript
    this.cards.set(card.id, card);
    this.onChange?.();
    return cloneCard(card);
```

Örnek (incrementAttempts):

```typescript
    c.attempts += 1;
    this.onChange?.();
    return c.attempts;
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/board/board.test.ts`
Expected: PASS (yeni + mevcut board testleri).

- [ ] **Step 5: Typecheck + tüm suite (regresyon)**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil (mevcut Board kullananlar bozulmadı — onChange undefined), typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/board/board.ts test/board/board.test.ts
git commit -m "feat: Board.onChange gözlemci (mutation sonrası bildirim)"
```

---

### Task 2: `progress.ts` + `runJob` `onEvent`

**Files:**
- Create: `src/engine/progress.ts`
- Modify: `src/engine/job.ts`
- Test: `test/engine/job.test.ts`

**Interfaces:**
- Produces: `ProgressEvent` (`{kind:"phase", phase, detail?}` | `{kind:"board", cards}`), `BoardCardView`, `snapshotBoard(board)`; `runJob` opts kazanır `onEvent?: (ev: ProgressEvent) => void`.

- [ ] **Step 1: Kırmızı test**

`test/engine/job.test.ts`'e ekle (`import type { ProgressEvent } from "../../src/engine/progress.js";` ekle):

```typescript
  it("done: onEvent faz sırası + board event'leri", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const adapter = fakeAdapter();
      const p = jobProvider({ intent: "feature" });
      const events: ProgressEvent[] = [];
      const res = await runJob(jdeps(p, mgr, adapter), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, onEvent: (e) => events.push(e) });
      expect(res.kind).toBe("done");
      const phases = events.filter((e) => e.kind === "phase").map((e) => (e as { phase: string }).phase);
      expect(phases).toEqual(["upstream", "approved", "board", "waves", "waves-done", "pr", "revision", "revision-done", "report", "done"]);
      expect(events.some((e) => e.kind === "board")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("chat: onEvent [upstream, chat]", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const p = jobProvider({ intent: "chat" });
      const events: ProgressEvent[] = [];
      await runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "merhaba", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, onEvent: (e) => events.push(e) });
      expect(events.filter((e) => e.kind === "phase").map((e) => (e as { phase: string }).phase)).toEqual(["upstream", "chat"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/job.test.ts`
Expected: FAIL — `progress.js` yok / `onEvent` emit etmiyor.

- [ ] **Step 3: progress.ts + runJob onEvent implement**

`src/engine/progress.ts` oluştur:

```typescript
import type { Board, Column } from "../board/board.js";

export interface BoardCardView {
  id: string;
  title: string;
  column: Column;
}

export type ProgressEvent =
  | { kind: "phase"; phase: string; detail?: string }
  | { kind: "board"; cards: BoardCardView[] };

/** Board'un anlık kart görünümü (id/title/column). */
export function snapshotBoard(board: Board): BoardCardView[] {
  return board.list().map((c) => ({ id: c.id, title: c.title, column: c.column }));
}
```

`src/engine/job.ts`:
- import ekle: `import { snapshotBoard, type ProgressEvent } from "./progress.js";`
- `runJob` opts imzasına ekle: `onEvent?: (ev: ProgressEvent) => void`.
- Gövdeyi emisyonlarla güncelle:

```typescript
export async function runJob(
  deps: JobDeps,
  opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string; revisionRounds?: number; onEvent?: (ev: ProgressEvent) => void },
): Promise<JobResult> {
  const emit = opts.onEvent ?? (() => {});
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  const workdir = session.baseWorktree;
  emit({ kind: "phase", phase: "upstream" });
  const up = await runUpstream(deps, workdir, opts.prompt, opts.askUser, opts.maxRounds);

  if (up.kind === "chat") {
    emit({ kind: "phase", phase: "chat" });
    await deps.manager.closeSession(session);
    return { kind: "chat", response: up.response };
  }
  if (up.kind === "rejected") {
    emit({ kind: "phase", phase: "rejected", detail: up.stage });
    await deps.manager.closeSession(session);
    return { kind: "rejected", stage: up.stage };
  }

  emit({ kind: "phase", phase: "approved" });
  await deps.manager.commitMerge(session, "hc: spec + plan");

  emit({ kind: "phase", phase: "board" });
  const board = await runProjectManager(pmOpts(deps, workdir, up.planPath));
  emit({ kind: "board", cards: snapshotBoard(board) });
  board.onChange = () => emit({ kind: "board", cards: snapshotBoard(board) });

  emit({ kind: "phase", phase: "waves" });
  const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
  emit({ kind: "phase", phase: "waves-done", detail: wave.status });

  let revision: RevisionResult | undefined;
  if (wave.status === "completed") {
    emit({ kind: "phase", phase: "pr", detail: wave.pr.url });
    const prDiff = await deps.manager.diff(session, opts.fromBranch);
    emit({ kind: "phase", phase: "revision" });
    revision = await runRevision(
      deps, session, board,
      (c) => deps.prAdapter.postComments(c),
      opts.askUser, opts.revisionRounds ?? 3, prDiff,
    );
    emit({ kind: "phase", phase: "revision-done", detail: revision.status });
  }

  emit({ kind: "phase", phase: "report" });
  const report = await runCoachReport(deps, session, board);
  emit({ kind: "phase", phase: "done" });
  return { kind: "done", wave, revision, report, session };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/job.test.ts`
Expected: PASS (yeni event testleri + mevcut chat/rejected/done/abort testleri — onEvent'siz çağrılar değişmez).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/progress.ts src/engine/job.ts test/engine/job.test.ts
git commit -m "feat: ProgressEvent + runJob onEvent emisyonları (faz + board)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 Board.onChange → Task 1; §3 ProgressEvent/snapshotBoard + §4 runJob onEvent → Task 2; §5 testler → her iki task. Tümü karşılandı.
- **Type consistency:** `ProgressEvent` (phase | board) union; `snapshotBoard` `BoardCardView[]` döner; runJob opts.onEvent opsiyonel; `board.onChange` set edilir (PM sonrası).
- **Geriye dönük uyum:** onChange/onEvent opsiyonel → mevcut Board/runJob kullananlar (H2 cli, tüm testler) değişmez; Task 1 Step 5 + Task 2 Step 5 tam suite ile doğrular.
- **Emisyon sırası:** phase event'leri deterministik (board event'leri ayrı kind, filtrelenince faz dizisi net); done testi tam diziyi toEqual ile kilitler.
