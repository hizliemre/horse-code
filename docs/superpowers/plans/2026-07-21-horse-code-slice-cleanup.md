# Dilim CLEANUP — Ertelenen Notlar Kapanışı Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **NOT:** Subagent limiti (200/200) dolu → **inline** (executing-plans) yürütülür: her task TDD + commit.

**Goal:** 3 gerçek robustluk fix'i (commitMerge no-op, nodeLineReader race, revision card-id) + backlog'un ledger'da kapanışı.

**Architecture:** Üç bağımsız, self-contained fix; farklı dosyalar. Sonra kalan ~30 not ledger'da gerekçeyle kapatılır.

**Tech Stack:** TypeScript ESM, vitest. Yeni bağımlılık yok.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; `.js`-suffixed import.
- vitest, **TDD**.
- **Geriye dönük uyum:** değişiklik-varsa commitMerge commit eder (mevcut testler yeşil); nodeLineReader interaktif davranış eşdeğer; revision id değişimi yalnız card-id (davranış aynı).
- Regresyon: tüm suite + typecheck yeşil.

---

### Task 1: `commitMerge` nothing-to-commit guard

**Files:**
- Modify: `src/worktree/manager.ts`
- Test: `test/worktree/merge.test.ts`

**Interfaces:**
- Consumes: `this.git` (non-throwing `{code}`).
- Produces: `commitMerge` sahne boşken no-op (commit yok, throw yok).

- [ ] **Step 1: Kırmızı test**

`test/worktree/merge.test.ts`'e ekle (dosyanın mevcut import'ları/`afterEach` cleanup'ıyla; `initTmpRepo`, `defaultGitRunner`, `WorktreeManager`, `repo` değişkeni deseni izlenir):
```typescript
  it("commitMerge sahnede değişiklik yoksa no-op (throw etmez, yeni commit yok)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const before = (await defaultGitRunner(["rev-parse", "HEAD"], s.baseWorktree)).stdout.trim();
    await expect(wm.commitMerge(s, "boş")).resolves.toBeUndefined();
    const after = (await defaultGitRunner(["rev-parse", "HEAD"], s.baseWorktree)).stdout.trim();
    expect(after).toBe(before); // yeni commit oluşmadı
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/worktree/merge.test.ts`
Expected: FAIL — commitMerge boş sahnede `git commit` "nothing to commit" ile throw eder.

- [ ] **Step 3: Guard implement**

`src/worktree/manager.ts` — `commitMerge`:
```typescript
  async commitMerge(session: WorktreeSession, message?: string): Promise<void> {
    await this.run(["add", "-A"], session.baseWorktree);
    const staged = await this.git(["diff", "--cached", "--quiet"], session.baseWorktree);
    if (staged.code === 0) return; // sahnede değişiklik yok → commit'i atla
    await this.run(message ? ["commit", "-m", message] : ["commit", "--no-edit"], session.baseWorktree);
  }
```

- [ ] **Step 4: Testi çalıştır — yeşil + tüm suite**

Run: `npx vitest run test/worktree/merge.test.ts && npm test`
Expected: yeni test PASS; mevcut commitMerge kullananlar (merge/revision/job/conflict testleri — hepsi değişiklik-var senaryosu) yeşil.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/worktree/merge.test.ts
git commit -m "fix: commitMerge sahne boşken no-op (nothing-to-commit throw'unu önle)"
```

---

### Task 2: `nodeLineReader` piped-race (buffered-queue)

**Files:**
- Modify: `src/terminal.ts`
- Test: `test/terminal.test.ts`

**Interfaces:**
- Produces: `nodeLineReader(input?, output?)` — injectable stream'ler; `on("line")` buffered-queue → ardışık `read()` race'siz.

- [ ] **Step 1: Kırmızı test**

`test/terminal.test.ts`'e ekle (import'lara `import { PassThrough } from "node:stream";` ve `nodeLineReader`'ı ekle):
```typescript
describe("nodeLineReader piped-race", () => {
  it("tüm input+EOF önce gelse de ardışık read'ler satırları kaçırmaz", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { read, close } = nodeLineReader(input, output);
    input.write("birinci\n");
    input.write("ikinci\n");
    input.end();
    expect(await read("q1")).toBe("birinci");
    expect(await read("q2")).toBe("ikinci");
    expect(await read("q3")).toBe(""); // EOF sonrası boş
    close();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/terminal.test.ts`
Expected: FAIL — `nodeLineReader` argüman almıyor / `rl.question` race'i ikinci satırı kaçırır (ya da hang).

- [ ] **Step 3: nodeLineReader implement**

`src/terminal.ts` — `nodeLineReader`'ı değiştir:
```typescript
export function nodeLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { read: LineReader; close: () => void } {
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(""); // kalan bekleyenlere boş cevap
  });
  const read: LineReader = (prompt) => {
    output.write(prompt + "\n> ");
    if (buffered.length) return Promise.resolve(buffered.shift()!);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => { waiters.push(resolve); });
  };
  return { read, close: () => rl.close() };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil + tüm suite**

Run: `npx vitest run test/terminal.test.ts && npm test`
Expected: yeni test PASS; mevcut terminal seam testleri (fake LineReader ile — nodeLineReader'dan bağımsız) yeşil.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/terminal.test.ts
git commit -m "fix: nodeLineReader buffered-queue (piped çoklu-soru race'ini gider)"
```

---

### Task 3: revision card-id namespace

**Files:**
- Modify: `src/engine/revision.ts`
- Test: `test/engine/revision.test.ts`

**Interfaces:**
- Produces: revision board card id `"revision"` → `"__revision__"` (task-slug collision imkânsız).

- [ ] **Step 1: Kod + test id'sini güncelle**

`src/engine/revision.ts` — TÜM `"revision"` (quoted) → `"__revision__"` (addCard id + 5 `appendStage("revision"` → `appendStage("__revision__"`). Önce doğrula: `grep -n '"revision"' src/engine/revision.ts` → 6 satır, hepsi card-id (title `"PR revision"` ve action `"pr:*"` ETKİLENMEZ).

`test/engine/revision.test.ts:87` — `board.get("revision")` → `board.get("__revision__")`.

- [ ] **Step 2: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/revision.test.ts`
Expected: PASS (id tutarlı: addCard + appendStage + get hepsi `__revision__`).

- [ ] **Step 3: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: yeşil, temiz.

- [ ] **Step 4: Commit**

```bash
git add src/engine/revision.ts test/engine/revision.test.ts
git commit -m "fix: revision board card-id namespace (__revision__ — task-slug collision önle)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 commitMerge → Task 1; §3 nodeLineReader → Task 2; §4 revision id → Task 3. Backlog kapanışı → merge sonrası ledger adımı (bu dilimin son işi, kod değil).
- **Type consistency:** `commitMerge(...): Promise<void>` imza aynı; `nodeLineReader(input?, output?)` opsiyonel default'lar (cli çağrısı değişmez); `LineReader` tipi aynı; revision id string sabit değişimi tutarlı (add/append/get).
- **Geriye dönük uyum:** commitMerge değişiklik-varsa commit (mevcut testler); nodeLineReader interaktif eşdeğer (default stdin/stdout); revision id yalnız internal card-id. Her task tam suite ile doğrular.
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
