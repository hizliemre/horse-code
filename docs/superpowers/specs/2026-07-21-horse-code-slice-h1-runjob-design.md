# horse-code Dilim H1 — runJob Orkestratörü (Headless) Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.2 akış)
**Üst dilim:** H (TUI/CLI + runJob). H1 = headless orkestratör (CLI H2, Ink H3).

---

## 1. Amaç ve Kapsam

Tüm parçaları **tek session'da** birleştiren üst-katman `runJob`: `openSession` → `runUpstream`
(F: refiner→spec→plan) → spec/plan'ı base'e commit → `runProjectManager` (board) →
`runWaveEngine`/`runWaves` (E4: dalgalar → PR) → coach raporu. Seam'ler (`askUser`/`askHuman`/
`approve`) enjekte edilir (headless varsayılan; gerçek terminal H2). **Birleşik session (Arch B):**
upstream session base worktree'sinde koşar → spec/plan PR'a girer.

Ayrıca **write/edit workdir-guard** (F3 güvenlik notu): dosya tool'ları cwd dışına yazamaz.

**Tüketir (tamam):** F `runUpstream`; E2 `runProjectManager`; E4 `runWaveEngine`; D
`WorktreeManager` (openSession/commitMerge/closeSession), `PRAdapter`, `WorktreeSession`; F2
`ReviewDeps`; E4 `WaveEngineDeps`/`WaveEngineResult`; E3b `AskHuman`; C `runToCompletion`;
E3a `readOnlyRegistry`.

Konum: `src/engine/job.ts` (runJob + runCoachReport); `src/engine/wave-engine.ts` (`runWaves` extract);
`src/tools/{write,edit}.ts` (workdir-guard).

### Kapsam DIŞI (H1 değil)
- **CLI girişi (`hcode` bin), gerçek terminal I/O, OmniRouteProvider wiring** → H2.
- **Ink TUI** → H3.
- **revision pipeline** (principal-coder, PR sonrası döngü) → G. runJob DONE'da session'ı **açık
  bırakır** (G devralır).
- **Gerçek prompt içerikleri, MCP PRAdapter** → G / config.

---

## 2. `runWaves` Extract (E4c refactor)

`runWaveEngine` şu an session'ı **kendi içinde açıyor**. runJob'un tek session'ı paylaşması için
çekirdek ayrılır:

```typescript
// wave-engine.ts — YENİ (extract):
export async function runWaves(
  deps: WaveEngineDeps, session: WorktreeSession, board: Board,
  opts: { base: string; prTitle?: string },
): Promise<WaveEngineResult>   // dalga döngüsü + push + openPR (openSession YOK)

// runWaveEngine artık delege eder (geriye dönük uyumlu — E4c testleri aynen geçer):
runWaveEngine(deps, board, { fromBranch, jobName, prTitle? }) =
  session = openSession(fromBranch, jobName); runWaves(deps, session, board, { base: fromBranch, prTitle })
```

`base` = PR'ın merge hedefi (fromBranch) + PR başlığı varsayılanı. runJob `runWaves`'i kendi
session'ıyla çağırır.

---

## 3. Bağımlılık Paketi + Sonuç Tipi

```typescript
export interface JobDeps extends ReviewDeps {   // provider, roleRegistry, skillRegistry, permission, approve, signal, councilRegistry, councilors
  manager: WorktreeManager;
  prAdapter: PRAdapter;
  rounds: number;         // escalation.rounds
  askHuman: AskHuman;     // task-escalation insan seam'i (E3b)
}

export type JobResult =
  | { kind: "chat"; response: string }
  | { kind: "rejected"; stage: "spec" | "plan" }
  | { kind: "done"; wave: WaveEngineResult; report: string; session: WorktreeSession };
```

`JobDeps` hem `ReviewDeps` (upstream) hem `WaveEngineDeps` (waves) hem `RoleAgentOptions` kurulumu
için yeterlidir.

---

## 4. `runJob(deps, opts): Promise<JobResult>`

`opts = { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string }`

```
session = await deps.manager.openSession(opts.fromBranch, opts.jobName)
workdir = session.baseWorktree
up = await runUpstream(deps, workdir, opts.prompt, opts.askUser, opts.maxRounds)

if up.kind === "chat":
   await deps.manager.closeSession(session)          // chat → session gereksiz
   return { kind: "chat", response: up.response }
if up.kind === "rejected":
   await deps.manager.closeSession(session)
   return { kind: "rejected", stage: up.stage }

// approved: up.specPath/up.planPath (workdir'e göre)
await deps.manager.commitMerge(session, "hc: spec + plan")   // spec/plan → baseBranch (PR'a girer)
board = await runProjectManager(pmOpts(deps, workdir, up.planPath))
wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle })
report = await runCoachReport(deps, session, board)
return { kind: "done", wave, report, session }              // session AÇIK bırakılır (G revision)
```

- **`pmOpts(deps, workdir, planPath)`:** `resolve("project-manager")` + `readOnlyRegistry(deps)` +
  mesaj "`<planPath>` plan'ını oku, task'lara böl" + `cwd: workdir`. `runProjectManager(opts)` →
  `Board` (TasksSchema).
- **`runCoachReport(deps, session, board)`:** `resolve("coach")` + `readOnlyRegistry` + mesaj
  (board kartları + kolonları + `stageHistory` özeti; "hangi task'ta ne oldu raporla") →
  `runToCompletion` → metin. cwd = `session.baseWorktree`.
- **commitMerge reuse:** D'nin `commitMerge` = `git add -A && git commit -m` (base worktree) —
  spec/plan'ı commit'lemek için yeniden kullanılır (yeni metod gerekmez).
- **Abort:** runJob try/catch içermez; alt birimler throw'u propagate eder.
- **Session yaşam döngüsü:** chat/rejected → `closeSession`; done → **açık** (G/kullanıcı kapatır).

---

## 5. write/edit workdir-guard (F3 güvenlik notu)

`src/tools/write.ts` ve `edit.ts`: `full = resolve(ctx.cwd, args.path)` **cwd sınırının dışına
çıkarsa** (`../../` kaçışı) `{ isError: true, content: "yol cwd dışında: ..." }` döner (yazma yapılmaz).
Sınır: `full === cwdResolved || full.startsWith(cwdResolved + path.sep)`. Böylece implementer/analyst
worktree dışına yazamaz.

---

## 6. Test Stratejisi

**İçerik-tabanlı deterministik provider** (tüm roller: refiner/coach/analyst/planner/councilor/
judge/project-manager/router/coder/senior-coder/architect/code-reviewer/team-lead). Gerçek tmp
git repo + bare remote (push) + fake `PRAdapter`.

- **runWaves (refactor):** `runWaveEngine` E4c testleri aynen geçer; `runWaves` enjekte session'la
  koşar → aynı sonuç.
- **write/edit guard:** `../dis.txt` → `isError`; `alt/ic.txt` (cwd içi) → yazılır.
- **runJob chat:** refiner `intent:"chat"` → `{kind:"chat", response}`; session kapatıldı.
- **runJob rejected:** spec onaylanmaz (judge revise + askUser durdur) → `{kind:"rejected", stage:"spec"}`; session kapatıldı.
- **runJob done (uçtan uca):** refiner feature → analyst spec → council/judge pass → planner plan →
  council/judge pass → commit → PM 1 task board → runWaves (router→coder→reviewer pass → merge) →
  push+openPR → coach raporu → `{kind:"done", wave.status:"completed", report}`; PRAdapter çağrıldı;
  spec/plan baseBranch'e commit'li.
- **abort:** pre-aborted → fırlatır.

Tümü `vitest`, TDD, içerik-tabanlı provider + gerçek fs+git (+ bare remote) + scripted seam'ler.

---

## 7. H1 DIŞI (bilinçli ertelenen)

- **CLI/bin, terminal I/O, provider wiring** → H2.
- **Ink TUI** → H3.
- **revision (G), DONE-sonrası closeSession/PR-review** → G.
- **spec/plan'ın session docs yoluna taşınması** (şimdilik workdir kökünde `spec.md`/`plan.md`) → ileride.

---

## 8. Açık Noktalar / İleride

- chat/rejected'te session açılıp kapanır (küçük israf; refiner session'dan önce çalıştırılıp
  atlanabilirdi ama runUpstream refiner'ı sarıyor — H2/ileride optimize edilebilir).
- `runCoachReport` board özetini metne döker; zengin format (Ink render) H3'te.
- DONE'da session açık kalır → çok iş çalıştırılırsa worktree birikir; kullanıcı/G `closeSession` eder.
- workdir-guard yalnız write/edit; shell zaten ayrı izin motorundan geçer (cwd-guard shell'e ayrıca eklenebilir, ileride).
