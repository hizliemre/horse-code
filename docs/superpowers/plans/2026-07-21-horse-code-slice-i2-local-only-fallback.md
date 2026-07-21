# Dilim I2 — Local-only Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** origin remote yoksa push/PR atla, iş yerel `hc/<slug>/base` branch'inde kalsın, rapor branch adını versin.

**Architecture:** Option C — merkezi: `manager.push` remote yoksa no-op; `unknown` PR adapter url'ine branch adı. cli/engine imzaları değişmez.

**Tech Stack:** TypeScript ESM, vitest. Yeni bağımlılık yok.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**.
- **Geriye dönük uyum:** origin VARSA push/PR yolları aynen çalışır (mevcut testler yeşil kalır — `pr.test.ts:19` push, job.test bare-origin completed). Yalnız origin YOKSA davranış değişir (throw yerine no-op).
- Gerçek push başarısızlığı (remote VAR, auth/network) hâlâ throw eder (guard yalnız remote-tanımsızda atlar).

---

### Task 1: Local-only fallback (`manager.push` no-op + unknown adapter url)

**Files:**
- Modify: `src/worktree/manager.ts` (`push` guard)
- Modify: `src/adapters/pr.ts` (unknown `createPR` url)
- Test: `test/worktree/pr.test.ts` (push no-op), `test/adapters/pr.test.ts` (unknown url)

**Interfaces:**
- Consumes: `this.git` (GitRunner — nonzero'da throw etmez, `{code}` döner).
- Produces: `push` origin yoksa no-op (throw yok); unknown adapter `createPR` → `{ url: "(yerel: <branch>)" }`.

- [ ] **Step 1: Kırmızı testler**

`test/worktree/pr.test.ts` — `describe("WorktreeManager push", ...)` bloğuna yeni `it` ekle (mevcut push testinden sonra):
```typescript
  it("origin yoksa push no-op (throw etmez)", async () => {
    repo = await initTmpRepo(); // origin EKLENMEZ
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    await expect(wm.push(s)).resolves.toBeUndefined(); // sessiz döner, hata yok
  });
```

`test/adapters/pr.test.ts` — unknown platform için `it` ekle (dosyanın mevcut import'larıyla; `makePRAdapter` import edilmiş olmalı):
```typescript
  it("unknown platform: createPR yerel branch url'i döner + PR açmaz", async () => {
    const logs: string[] = [];
    const run = async () => ({ code: 0, stdout: "", stderr: "" }); // çağrılmamalı
    const adapter = makePRAdapter({ platform: "unknown", run, cwd: "/x", log: (s) => logs.push(s) });
    const res = await adapter.createPR({ branch: "hc/job/base", base: "main", title: "t", body: "b" });
    expect(res.url).toBe("(yerel: hc/job/base)");
    expect(logs.join("\n")).toContain("hc/job/base");
  });
```
(Not: `test/adapters/pr.test.ts`'te `makePRAdapter` import'u yoksa import satırına ekle; `run` tipi `CmdRunner` ile uyumlu — `(argv, cwd?) => Promise<{code,stdout,stderr}>`. Mevcut testlerdeki fake runner imzasını izle.)

- [ ] **Step 2: Testleri çalıştır — kırmızı**

Run: `npx vitest run test/worktree/pr.test.ts test/adapters/pr.test.ts`
Expected: FAIL — push origin'siz throw ediyor; unknown url `(bilinmeyen platform — PR açılmadı)` (yeni url değil).

- [ ] **Step 3: `manager.push` guard**

`src/worktree/manager.ts` — `push` metodunu değiştir:
```typescript
  async push(session: WorktreeSession, remote = "origin"): Promise<void> {
    const check = await this.git(["remote", "get-url", remote], session.baseWorktree);
    if (check.code !== 0) return; // remote yok → local-only, push atla
    await this.run(["push", remote, session.baseBranch], session.baseWorktree);
  }
```

- [ ] **Step 4: unknown adapter url**

`src/adapters/pr.ts` — `makePRAdapter` unknown dalındaki `createPR`'ı değiştir:
```typescript
    async createPR(input) {
      opts.log(`PR (yerel — remote/platform yok): ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: `(yerel: ${input.branch})` };
    },
```

- [ ] **Step 5: Testleri çalıştır — yeşil**

Run: `npx vitest run test/worktree/pr.test.ts test/adapters/pr.test.ts`
Expected: PASS (yeni + mevcut push/adapter testleri).

- [ ] **Step 6: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tümü yeşil (origin'li push/PR yolları değişmedi — `pr.test.ts:19` + job.test bare-origin completed korunur), typecheck temiz.

- [ ] **Step 7: Commit**

```bash
git add src/worktree/manager.ts src/adapters/pr.ts test/worktree/pr.test.ts test/adapters/pr.test.ts
git commit -m "feat: local-only fallback (origin yoksa push no-op + yerel branch PR url'i)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 push no-op → Step 3; §3 unknown url → Step 4; §5 testler → Step 1. Tümü karşılandı.
- **Type consistency:** `push(session, remote="origin"): Promise<void>` imza aynı; `this.git` `{code}` döner (throw yok); unknown `createPR` `{url: string}` döner.
- **Geriye dönük uyum:** origin VARSA `check.code===0` → push çalışır (mevcut `pr.test.ts:19` + job.test bare-origin completed korunur). Yalnız origin YOKSA no-op. Step 6 tam suite ile doğrular.
- **Gerçek hata korunur:** remote VAR ama push başarısız → `this.run` throw → Fix #4 temizler (guard yalnız remote-tanımsızda atlar).
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
