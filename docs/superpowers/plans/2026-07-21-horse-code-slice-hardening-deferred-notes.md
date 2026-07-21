# Dilim HARDENING — Ertelenen Notlar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4 yüksek-değerli ertelenen notu kapat: spec/plan `.hc/`'ye, prDiff size-cap, TUI çift-`>`, session leak.

**Architecture:** 4 bağımsız fix, her biri kendi test döngüsüne sahip. #1 upstream path sabiti + testler; #2 manager.diff truncation; #3 terminal seam caret sunumu; #4 runJob try/catch cleanup.

**Tech Stack:** TypeScript ESM, vitest. Yeni bağımlılık yok.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**. Regresyon: her fix sonrası tüm suite (330 → ~334) + typecheck + build yeşil.
- **Geriye dönük uyum:** #1 spec/plan committed kalır (yalnız yol değişir); #3 parse mantığı (`e/h`, `accept/retry/abandon`) değişmez, readline caret'i korunur; #4 başarı/chat/rejected yolları davranışça aynı, yalnız throw'da temizlik eklenir.
- **`.hc/` gitignore'da DEĞİL** (`.horsecode/` gitignore'da) → `commitMerge git add -A` `.hc/`'yi PR'a alır.
- **`review.test.ts` DOKUNULMAZ:** oradaki `"spec.md"` explicit path-param (filename-agnostik), runUpstream sabitinden bağımsız.

---

### Task 1: Fix #1 — spec/plan → `.hc/`

**Files:**
- Modify: `src/engine/upstream.ts` (specPath/planPath sabitleri)
- Test: `test/engine/upstream.test.ts`, `test/engine/job.test.ts`

**Interfaces:**
- Consumes: `runAnalyst`/`runPlanner`/`runReviewLoop` path-param'ları (değişmez); `write_file` mkdir-parent (write.ts:32).
- Produces: `UpstreamResult.approved` `{ specPath: ".hc/spec.md", planPath: ".hc/plan.md" }` döner (PM/coach threading değişmez).

**Yaklaşım (neden mock path-aware):** İki test dosyasındaki içerik-tabanlı mock, analyst/planner write path'ini **hardcode** ediyor (`"spec.md"`/`"plan.md"`). Aynı mock hem `runUpstream` entegrasyon testi (Fix sonrası `.hc/` bekler) hem `runAnalyst`/`runPlanner` **unit** testleri (explicit `"spec.md"` geçer) tarafından kullanılıyor → hardcode'u körce flip edersek unit testler kırılır; ham `writeFile(join(dir, ".hc/spec.md"))` setup'ları da mkdir'siz ENOENT verir. Çözüm: mock, yazacağı path'i **user mesajından** çıkarsın. Böylece unit testler (`"spec.md"` mesajı → mock `spec.md` yazar) VE entegrasyon (`.hc/spec.md` mesajı → mock `.hc/spec.md` yazar) ikisi de değişmeden çalışır; yalnız entegrasyon assert'leri `.hc/`'ye döner. Regex hem `"X.md"'e write_file` (non-revise) hem ilk-`"X.md"` (revise) ifadesini kapsar — analyst+planner dört varyantta da doğru hedefi verir.

- [ ] **Step 1: Mock'ları path-aware yap + entegrasyon assert'lerini `.hc/`'ye çevir**

`test/engine/upstream.test.ts`:
- (a) `chat()` içinde `const toolMsgs = req.messages.filter((m) => m.role === "tool");` satırından SONRA ekle:
```typescript
      const userContent = req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const writeTarget = (userContent.match(/"([^"]+\.md)"'e write_file/) ?? userContent.match(/"([^"]+\.md)"/))?.[1] ?? "spec.md";
```
- (b) Satır 47: `path: "spec.md"` → `path: writeTarget`. Satır 51: `path: "plan.md"` → `path: writeTarget`.
- (c) Satır 165: `.toBe("spec.md")` → `.toBe(".hc/spec.md")`; 166: `.toBe("plan.md")` → `.toBe(".hc/plan.md")`; 168: `join(dir, "spec.md")` → `join(dir, ".hc/spec.md")`; 169: `join(dir, "plan.md")` → `join(dir, ".hc/plan.md")`.
- **DEĞİŞMEZ:** runAnalyst/runPlanner unit testleri (107,108,117,125,127,133,135,136,143,145) `"spec.md"`/`"plan.md"` kalır (mock mesajdan `spec.md` çıkarır → tutar).

`test/engine/job.test.ts`:
- (a) `chat()` içinde `const toolMsgs = req.messages.filter((m) => m.role === "tool");` satırından SONRA ekle (aynı iki satır):
```typescript
      const userContent = req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const writeTarget = (userContent.match(/"([^"]+\.md)"'e write_file/) ?? userContent.match(/"([^"]+\.md)"/))?.[1] ?? "spec.md";
```
- (b) Satır 47: `path: "spec.md"` → `path: writeTarget`. Satır 51: `path: "plan.md"` → `path: writeTarget`.
- (c) Satır 160: `join(res.session.baseWorktree, "spec.md")` → `join(res.session.baseWorktree, ".hc/spec.md")`; 161: `"plan.md"` → `".hc/plan.md"`.

`test/engine/review.test.ts`: **DOKUNULMAZ** (explicit path-param, bağımsız).

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/upstream.test.ts test/engine/job.test.ts`
Expected: FAIL — `runUpstream` hâlâ `"spec.md"`/`"plan.md"` sabitini kullanıyor; entegrasyon assert'leri artık `.hc/` bekliyor → `res.specPath === ".hc/spec.md"` ve `readFile(".hc/spec.md")`/`existsSync(".hc/...")` tutmuyor. (Unit testler yeşil kalır.)

- [ ] **Step 3: upstream.ts sabitlerini değiştir**

`src/engine/upstream.ts`:
- Satır 119: `const specPath = "spec.md";` → `const specPath = ".hc/spec.md";`
- Satır 130: `const planPath = "plan.md";` → `const planPath = ".hc/plan.md";`

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/upstream.test.ts test/engine/job.test.ts`
Expected: PASS — analyst/planner `.hc/`'ye yazar, guard + asserts tutar.

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tümü yeşil (`review.test.ts` "spec.md" ile bağımsız çalışır), typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/upstream.ts test/engine/upstream.test.ts test/engine/job.test.ts
git commit -m "fix: spec/plan .hc/ altına (gerçek repo spec.md/plan.md ezmesini önle)"
```

---

### Task 2: Fix #2 — prDiff size-cap

**Files:**
- Modify: `src/worktree/manager.ts` (`diff()` + `MAX_DIFF_CHARS`)
- Test: `test/worktree/diff.test.ts` (yeni)

**Interfaces:**
- Consumes: `GitRunner` (inject), `WorktreeSession`.
- Produces: `diff()` çıktısı `MAX_DIFF_CHARS`'ı aşarsa kesilip kesme-notu eklenir; aşmıyorsa aynen döner.

- [ ] **Step 1: Kırmızı test**

`test/worktree/diff.test.ts` oluştur:
```typescript
import { describe, it, expect } from "vitest";
import { WorktreeManager, type WorktreeSession } from "../../src/worktree/manager.js";
import type { GitRunner } from "../../src/worktree/git.js";

const session: WorktreeSession = { jobSlug: "j", root: "/r", baseWorktree: "/r/base", baseBranch: "hc/j/base" };

function mgrWithDiff(stdout: string): WorktreeManager {
  const runGit: GitRunner = async () => ({ code: 0, stdout, stderr: "" });
  return new WorktreeManager({ repoRoot: "/r", runGit });
}

describe("manager.diff size-cap", () => {
  it("kısa diff aynen döner", async () => {
    expect(await mgrWithDiff("kısa diff").diff(session, "main")).toBe("kısa diff");
  });

  it("uzun diff kesilir + kesme-notu eklenir", async () => {
    const long = "x".repeat(70_000);
    const out = await mgrWithDiff(long).diff(session, "main");
    expect(out.length).toBeLessThan(70_000);
    expect(out).toContain("diff kısaltıldı");
    expect(out).toContain("10000 karakter atlandı"); // 70000 - 60000
    expect(out.startsWith("x".repeat(100))).toBe(true); // baş korunur
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/worktree/diff.test.ts`
Expected: FAIL — `diff()` sınırsız döndürüyor (uzun diff 70_000 uzunlukta, kesme-notu yok).

- [ ] **Step 3: manager.diff truncation implement**

`src/worktree/manager.ts`:
- İmport'lardan sonra (satır 5 civarı, `class` öncesi) modül-üstü sabit ekle:
```typescript
/** PR diff'i revision prompt'unu şişirmesin: bu char sınırının üstü kesilir. */
const MAX_DIFF_CHARS = 60_000;
```
- `diff()` metodunu değiştir (satır 89-92):
```typescript
  async diff(session: WorktreeSession, base: string): Promise<string> {
    const r = await this.git(["diff", `${base}...${session.baseBranch}`], session.baseWorktree);
    const out = r.stdout;
    if (out.length <= MAX_DIFF_CHARS) return out;
    return out.slice(0, MAX_DIFF_CHARS) + `\n… (diff kısaltıldı: ${out.length - MAX_DIFF_CHARS} karakter atlandı)`;
  }
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/worktree/diff.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tümü yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/worktree/manager.ts test/worktree/diff.test.ts
git commit -m "fix: manager.diff size-cap (büyük PR revision context taşmasını önle)"
```

---

### Task 3: Fix #3 — TUI çift-`>` (seam caret sunumu)

**Files:**
- Modify: `src/terminal.ts`
- Test: `test/terminal.test.ts`

**Interfaces:**
- Produces: `makeAskUser`/`makeApprove`/`makeAskHuman` **ham soru** üretir (sonda caret yok); `nodeLineReader` prompt'a `\n> ` caret ekler. Parse mantığı ve `LineReader` tipi değişmez.

- [ ] **Step 1: Kırmızı test**

`test/terminal.test.ts`'e ekle (dosya sonundaki son `});`'den önce):
```typescript
describe("seam caret sunumu (TUI çift-'>' önlenir)", () => {
  it("seam prompt'ları caret ile bitmez (caret reader'a taşındı)", async () => {
    let captured = "";
    const cap = async (p: string) => { captured = p; return "x"; };
    await makeAskUser(cap)("Soru?");
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeApprove(cap)(req);
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeAskHuman(cap)({ card, verdict });
    expect(captured.trimEnd().endsWith(">")).toBe(false);
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/terminal.test.ts`
Expected: FAIL — seam prompt'ları `> ` caret'i ile bitiyor (trimEnd → ">").

- [ ] **Step 3: terminal.ts — caret'i reader'a taşı**

`src/terminal.ts`:
- `makeAskUser` (satır 9):
```typescript
  return (question) => read(`\n[soru] ${question}`);
```
- `makeApprove` (satır 14):
```typescript
    const ans = (await read(`\n[izin] ${req.preview}\nonayla? (e/h)`)).trim().toLowerCase();
```
- `makeAskHuman` (satır 22):
```typescript
    const ans = (await read(`\n[insan] task "${ctx.card.title}" — ${notes}\n(accept / retry: <not> / abandon)`)).trim();
```
- `nodeLineReader` (satır 38-39) — `read`'e caret ekle:
```typescript
  return { read: (prompt) => rl.question(prompt + "\n> "), close: () => rl.close() };
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/terminal.test.ts`
Expected: PASS (yeni caret testi + mevcut `toContain("X mi?")`/parse testleri — cevap-parse değişmedi).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tümü yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/terminal.ts test/terminal.test.ts
git commit -m "fix: seam caret'ini nodeLineReader'a taşı (TUI çift-'>' düzelt)"
```

---

### Task 4: Fix #4 — session leak (throw'da orphan worktree temizle)

**Files:**
- Modify: `src/engine/job.ts` (`runJob` try/catch)
- Test: `test/engine/job.test.ts`

**Interfaces:**
- Consumes: `deps.manager.closeSession`.
- Produces: `runJob` beklenmedik throw'da `session`'ı kapatıp hatayı yeniden fırlatır; başarı/chat/rejected yolları değişmez.

- [ ] **Step 1: Kırmızı test**

`test/engine/job.test.ts`'e ekle (mevcut `describe` bloğu içine, uygun bir yere):
```typescript
  it("beklenmedik throw'da session temizlenir (orphan worktree yok)", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      let closed = false;
      const origClose = mgr.closeSession.bind(mgr);
      mgr.closeSession = async (s) => { closed = true; return origClose(s); };
      mgr.commitMerge = async () => { throw new Error("patla"); }; // approved sonrası erken throw
      const p = jobProvider({ intent: "feature" });
      await expect(
        runJob(jdeps(p, mgr, fakeAdapter()), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2 }),
      ).rejects.toThrow("patla");
      expect(closed).toBe(true); // catch closeSession'ı çağırdı
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/job.test.ts`
Expected: FAIL — `runJob` try/catch'siz; `commitMerge` throw'u closeSession'sız yayılır (`closed === false`).

- [ ] **Step 3: runJob'ı try/catch ile sar**

`src/engine/job.ts` — `const session = await deps.manager.openSession(...)` satırından SONRAKI tüm gövdeyi (emit upstream'den `return { kind: "done", ... }`'e kadar) `try`'a al; sonuna `catch` ekle. `openSession` `try` DIŞINDA kalır (henüz session yok → sızıntı yok).

Yapı (mevcut gövde aynen `try` içine girer):
```typescript
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  try {
    const workdir = session.baseWorktree;
    emit({ kind: "phase", phase: "upstream" });
    // ... mevcut gövdenin TAMAMI (chat/rejected close'ları + waves + revision + done return) ...
    return { kind: "done", wave, revision, report, session };
  } catch (e) {
    await deps.manager.closeSession(session).catch(() => {}); // orphan worktree temizle; cleanup hatası orijinali gölgelemesin
    throw e;
  }
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/job.test.ts`
Expected: PASS (yeni throw-cleanup testi + mevcut done/chat/rejected/event testleri — başarı yolunda catch çalışmaz, done worktree korunur).

- [ ] **Step 5: Tüm suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: tümü yeşil, typecheck temiz, `dist/cli.js` build olur.

- [ ] **Step 6: Commit**

```bash
git add src/engine/job.ts test/engine/job.test.ts
git commit -m "fix: runJob throw'da session temizle (orphan worktree sızıntısını önle)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 (#1 .hc/) → Task 1; §3 (#2 prDiff cap) → Task 2; §4 (#3 caret) → Task 3; §5 (#4 session) → Task 4. Tümü karşılandı.
- **Type consistency:** `MAX_DIFF_CHARS` number; `diff()` `Promise<string>` (imza değişmez); `WorktreeSession` test-import'u; `LineReader` tipi değişmez; `closeSession(session): Promise<void>` `.catch()` ile.
- **Geriye dönük uyum:** #1 spec/plan committed kalır (yol değişir, `review.test.ts` bağımsız); #3 parse + readline caret korunur; #4 başarı/chat/rejected yolları aynen (yalnız throw'da temizlik). Her task Step 5 tam suite ile doğrular.
- **Test-mock tutarlılığı:** #1'de mock write-path'i user mesajından çıkarılır (`writeTarget`) → analyst'ın yazdığı yol == runUpstream'in söylediği yol == guard'ın kontrol ettiği yol; unit testler (explicit `"spec.md"`) mock-değişiminden etkilenmez, yalnız entegrasyon assert'leri `.hc/`'ye döner. `review.test.ts` dokunulmaz.
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
