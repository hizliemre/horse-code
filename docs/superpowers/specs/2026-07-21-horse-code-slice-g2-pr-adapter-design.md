# horse-code Dilim G2 — Gerçek PR Adapter + runJob Entegrasyonu Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§7 PR review, §8 revision)
**Üst dilim:** G. G2 = revision'ı gerçekleştirir (gerçek gh/az PR + runJob wiring).

---

## 1. Amaç ve Kapsam

G1'in adapter-agnostik `runRevision`'ını **gerçek dünyaya** bağlar: platforma göre (`gh`/`az`)
gerçek PR açan + yorum işleyen adapter; `runJob`'da `runWaves` completed olunca **PR diff'iyle**
`runRevision`'ı koşar. H2 stub'ı gerçeğiyle değişir. G1 #1 (diff-scoping) çözülür.

**Tüketir (tamam):** G1 `runRevision`/`RevisionResult`; D `PRAdapter`/`WorktreeManager`/`GitRunner`;
H1 `runJob`/`JobDeps`/`JobResult`; H2 `logPRAdapter`/`buildJobDeps`/`cli`; C `child_process` (spawn).

Konum: `src/adapters/pr.ts` (CmdRunner + adapter'lar); `src/worktree/manager.ts` (`diff`);
`src/engine/revision.ts` (`prDiff` param); `src/engine/job.ts` (revision entegrasyonu);
`src/wiring.ts`/`src/cli.ts` (gerçek adapter wiring).

### Kapsam DIŞI (G2 değil)
- **Ink TUI** → H3.
- **Azure PR thread yorumları (REST/thread API)** — G2 `az` createPR gerçek; yorumlar best-effort
  log (senior fix'leri push ile PR güncellenir; tam thread-comment ileride REST/MCP).
- **Rafine prompt'lar** → ileride.

---

## 2. Adapter Katmanı (`src/adapters/pr.ts`)

```typescript
export type CmdRunner = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
export const defaultCmdRunner: CmdRunner;   // child_process.spawn; asla throw etmez (GitRunner gibi)

export interface RevisionPRAdapter extends PRAdapter {
  postComments(comments: string[]): Promise<void>;
}

export function parsePRNumber(url: string): number | undefined;   // .../pull/123 veya .../pullrequest/123 → 123

export function ghAdapter(run: CmdRunner, cwd: string): RevisionPRAdapter;
  // createPR: `gh pr create --base <base> --head <branch> --title <t> --body <b>` → stdout=url; number url'den (stateful sakla)
  // postComments: `gh pr comment <number> --body <birleşik yorumlar>` (PR yoksa no-op)

export function azAdapter(run: CmdRunner, cwd: string, log: (s: string) => void): RevisionPRAdapter;
  // createPR: `az repos pr create --source-branch <branch> --target-branch <base> --title <t> --description <b> -o json` → JSON.pullRequestId + url
  // postComments: az thread yorumu G2'de best-effort → log(`Azure PR #<n> yorumları: <comments>`) (tam thread API ileride)

export function detectPlatform(remoteUrl: string): "github" | "azure" | "unknown";
  // github.com → github; dev.azure.com/visualstudio.com → azure; diğer → unknown

export function makePRAdapter(opts: { platform: "github" | "azure" | "unknown"; run: CmdRunner; cwd: string; log: (s: string) => void }): RevisionPRAdapter;
  // github → ghAdapter; azure → azAdapter; unknown → logPRAdapter (H2 stub)
```

`logPRAdapter` (H2 `wiring.ts`) `RevisionPRAdapter`'a genişler: `postComments` → `log("PR yorumları: <comments>")` (no-op).

**Stateful adapter:** `createPR` PR number'ı instance'ta saklar; `postComments` onu kullanır
(`openPR` number'ı düşürse de adapter içeride tutar). Bir job = bir adapter instance = bir PR.

---

## 3. D Uzantısı — `WorktreeManager.diff`

```typescript
/** base branch'e karşı base worktree'deki değişikliklerin unified diff'i (PR diff'i). */
async diff(session: WorktreeSession, base: string): Promise<string> {
  const r = await this.git(["diff", `${base}...${session.baseBranch}`], session.baseWorktree);
  return r.stdout;
}
```

---

## 4. `runRevision` — `prDiff` Param (G1 #1)

`runRevision(deps, session, board, postComments, askUser, maxRounds, prDiff?)` — `prDiff` **opsiyonel,
son param** (G1 testleri değişmez). `principalReview` mesajı `prDiff` varsa onu içerir → principal-coder
**sadece değişiklikleri** review eder; yoksa mevcut tüm-ağaç davranışı (geri dönük uyumlu):

```
principalReview: mesaj = prDiff ? `Şu PR diff'ini review et:\n${prDiff}\n(gerekirse read-tool'larla worktree'yi de incele)` : "base worktree'deki değişiklikleri incele"
```

---

## 5. runJob Entegrasyonu (`src/engine/job.ts`)

- `JobDeps.prAdapter: RevisionPRAdapter` (PRAdapter yerine — postComments için). H2 wiring bunu üretir.
- `opts` kazanır `revisionRounds?: number` (varsayılan 3).
- done akışı: `runWaves` **completed** ise revision koş:

```
wave = await runWaves(...)
let revision: RevisionResult | undefined
if wave.status === "completed":
   const prDiff = await deps.manager.diff(session, opts.fromBranch)
   revision = await runRevision(deps, session, board, (c) => deps.prAdapter.postComments(c), opts.askUser, opts.revisionRounds ?? 3, prDiff)
report = await runCoachReport(...)
return { kind: "done", wave, revision, report, session }
```

`JobResult.done` kazanır `revision?: RevisionResult`. Partial'da revision yok (PR açılmadı).

---

## 6. cli.ts Wiring

- `remoteUrl = git remote get-url origin` (defaultGitRunner, hata→"" → unknown).
- `platform = detectPlatform(remoteUrl)`.
- `prAdapter = makePRAdapter({ platform, run: defaultCmdRunner, cwd, log: console.log })`.
- `buildJobDeps(... prAdapter ...)` (H2 stub yerine gerçek). `runJob` opts'a `revisionRounds` (flag `--revision-rounds` opsiyonel, varsayılan 3).
- `renderResult` `done`'da `revision` durumunu da yazar (approved/accepted/human).

---

## 7. Test Stratejisi

Ağsız/CLI-suz: **fake `CmdRunner`** (komutları kaydeder, sabit çıktı döner) + gerçek tmp git
(diff için) + içerik-provider (revision rolleri) + fake seam'ler.

- **parsePRNumber:** github `.../pull/123`→123; azure `.../pullrequest/45`→45; geçersiz→undefined.
- **ghAdapter:** createPR fake runner → `gh pr create --base --head --title --body` komutu kuruldu,
  stdout url → `{url, number}`; postComments → `gh pr comment <n> --body` kuruldu; PR açılmadan postComments→no-op.
- **azAdapter:** createPR → `az repos pr create --source-branch --target-branch ... -o json`, JSON→number/url;
  postComments → log çağrıldı (yorumlar log'da).
- **detectPlatform:** github/azure/unknown.
- **makePRAdapter:** platforma göre doğru adapter (github createPR gh komutu; azure az; unknown log).
- **logPRAdapter.postComments:** log çağrılır (no-op).
- **manager.diff:** gerçek tmp repo + değişiklik → unified diff'te değişiklik satırları.
- **runRevision prDiff:** prDiff verilince principal review isteğinin mesajı diff'i içerir; verilmezse eski davranış.
- **runJob revision:** wave completed → `deps.manager.diff` çağrıldı + `runRevision` koştu + `deps.prAdapter.postComments`
  değişiklikte çağrıldı → `{kind:"done", revision}`; partial → revision yok.
- **cli:** detectPlatform + makePRAdapter wiring (parseArgs/renderResult revision satırı).

Tümü `vitest`, TDD, fake CmdRunner + gerçek tmp git + içerik-provider.

---

## 8. G2 DIŞI (bilinçli ertelenen)

- **Azure PR thread yorumları (REST/thread API)** — G2 log-best-effort; tam desteği ileride.
- **Ink TUI** → H3.
- **G1 #2 (card namespace), #4 (maxRounds≥2)** — G2 revisionRounds varsayılan 3 (≥1); card namespace ileride.

---

## 9. Açık Noktalar / İleride

- `gh`/`az` kurulu + auth + doğru remote gerektirir; yoksa createPR throw → runJob throw (H1 session-leak
  notu geçerli; H2/ileride cleanup). unknown platform → logAdapter (PR açılmaz, log).
- `diff base...baseBranch` merge edilmiş tüm işi gösterir; boş diff (değişiklik yok) → principal yine review eder.
- az createPR org/project/repo tespiti `az` config/remote'a bağlı; eksikse hata (kullanıcı `az` kurar).
- postComments tek birleşik yorum (numaralı liste); thread-başına yorum ileride.
