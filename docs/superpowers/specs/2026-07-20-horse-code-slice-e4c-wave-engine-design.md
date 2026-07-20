# horse-code Dilim E4c — Dalga Motoru + Session + PR Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.2–5.3 dış döngü)
**Önceki dilimler:** E4a (`runWaveTask`), E4b (`runConflictCouncil`), E2 (`runTeamLead`), D (`WorktreeManager`).

---

## 1. Amaç ve Kapsam

E4'ü tamamlayan **deterministik dış döngü** `runWaveEngine`: session base worktree'sini aç
(`openSession`) → team-lead dalgaları (`runTeamLead`) → her dalgayı sırayla koş — dalga içi
task'lar **paralel** (`runWaveTask`), merge'ler **serileştirilmiş**, conflict'ler merge kilidi
içinde **çözülür** (`runConflictCouncil`) → başarısız task'ın **bağımlıları atlanır** → tüm
task'lar başarılıysa `push` + `openPR`, değilse `{partial}` döner.

**Tüketir (tamam):** E4a `runWaveTask` (+ bu dilimde `resolveConflict` seam'i eklenir); E4b
`runConflictCouncil`; E2 `runTeamLead`; D `WorktreeManager` (openSession/deriveTask/mergeTask/
commitMerge/abortMerge/push/openPR), `PRAdapter`, `WorktreeSession`; E1 `Board`; E3b
`EscalationDeps`; B2 `ToolRegistry`; E-skills `buildSkillTool`.

Konum: E4a genişletmesi `src/engine/wave-task.ts`; motor `src/engine/wave-engine.ts`.

### Kapsam DIŞI (E4c değil)
- **`closeSession`/worktree cleanup** → G/H (revision base worktree'de çalışır; session açık kalır).
- **Gerçek GitHub/Azure MCP PRAdapter** → G (E4c enjekte adapter alır).
- **Gerçek `askHuman` terminal** → H (E4c varsayılan otonom callback alır).
- **project-manager board'u kurar** (E2/F upstream) — E4c dolu board alır.
- **coach final raporu** → H (E4c `{partial}`/`{completed}` yapısal sonuç döner).

---

## 2. Kritik Mimari — Paralellik + Merge Serileştirme

Dalga içi task'lar izole worktree'lerde **paralel** koşar (yavaş LLM kısmı). Ama base worktree
**paylaşımlı**: (a) `deriveTask` (repo'da `git worktree add`) ve (b) `mergeTask` (base worktree)
yarışır; ayrıca D sözleşmesi bir merge'i **conclude etmeden** (commit/abort) ikinci merge'i
yasaklar. Naif mutex yetmez: task B merge conflict verip mutex'i bırakırsa, task C'nin merge'i
base mid-merge iken başlar ve patlar.

**Çözüm — `runWaveTask`'a `resolveConflict` seam'i (E4a genişletmesi):** conflict, serileştirilen
merge bloğunun **İÇİNDE** çözülür. Tek paylaşımlı mutex derive+merge+resolve'ı serileştirir;
escalation serileştirilmez (paralel kalır).

```typescript
// wave-task.ts genişleme
export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
  resolveConflict?: (task: TaskWorktree, files: string[]) => Promise<MergeResult>;
}
// runWaveTask merge bloğu:
const mr = await ser(async () => {
  const r = await deps.manager.mergeTask(session, tw);
  if (r.status === "conflict" && deps.resolveConflict) return deps.resolveConflict(tw, r.files);
  return r;
});
// sonra mr.status'a göre dallan (merged / conflict) — mevcut mantık
```

`resolveConflict` yoksa E4a **bugünkü davranışını korur** (conflict relay) → geriye dönük uyumlu,
mevcut E4a testleri geçer.

---

## 3. Birimler

### 3.1 `createMutex(): <T>(fn) => Promise<T>` (wave-engine.ts)

Söz-zinciri mutex: her çağrı öncekinin ardından koşar. `deriveTask`/`mergeTask`/`resolveConflict`'i
bir dalga boyunca serileştirir. `fn`'in sonucunu/hatasını aynen döndürür.

### 3.2 `runWave(deps, session, board, taskIds, blocked): Promise<WaveOutcome>` (wave-engine.ts)

Tek dalga: `blocked` kümesindeki bir bağımlılığa sahip task'ları **atla**, kalanları paylaşımlı
mutex + `resolveConflict` sarmalayıcısıyla **paralel** koş, sonuçları sınıfla.

```
WaveOutcome = { merged: string[]; failed: string[]; skipped: string[] }

skipped  = taskIds.filter(t => board.get(t).deps.some(d => blocked.has(d)))
runnable = taskIds \ skipped
for t of skipped: appendStage(t, {role:"team-lead", action:"skipped", note:"bağımlılık başarısız"})

ser = createMutex()
results = await Promise.all(runnable.map(t =>
  runWaveTask({ ...deps, serialize: ser, resolveConflict: wrap(t) }, session, board, t)))
merged = t'ler status==="merged"; failed = t'ler status!=="merged"
return { merged, failed, skipped }
```

`wrap(t)` = conflict sarmalayıcısı (merge kilidi içinde çağrılır):
```
async (tw, files) => {
  try {
    r = await runConflictCouncil(deps, session, board, t, tw)   // {resolved}|{unresolved}
    return r.status === "resolved" ? { status:"merged" } : { status:"conflict", files }
  } catch (e) {
    if (deps.signal.aborted) throw e
    try { await deps.manager.abortMerge(session) } catch {}      // E4b notu #3: base mid-merge kalmasın
    return { status:"conflict", files }
  }
}
```

> **Abort:** `deps.signal.aborted` iken council throw'u yukarı fırlar (yutulmaz). Task'ın kendi
> abort/hata'sı `Promise.all`'ı reject eder → motor durur (abort propagate).

### 3.3 `runWaveEngine(deps, board, opts): Promise<WaveEngineResult>` (wave-engine.ts)

```
WaveEngineDeps extends EscalationDeps { manager: WorktreeManager; prAdapter: PRAdapter }
opts = { fromBranch: string; jobName: string; prTitle?: string }
WaveEngineResult =
  | { status:"completed"; session; pr:{url}; waves }
  | { status:"partial";  session; failed:string[]; skipped:string[]; waves }

session = await deps.manager.openSession(opts.fromBranch, opts.jobName)
waves   = await runTeamLead(teamLeadOpts(deps, session), board)   // resolve("team-lead") + skill tool

blocked = new Set(); allFailed=[]; allSkipped=[]
for wave of waves:
   o = await runWave(deps, session, board, wave, blocked)
   for t of o.failed:  blocked.add(t); allFailed.push(t)
   for t of o.skipped: blocked.add(t); allSkipped.push(t)
   # başarılı merge'ler base'e commit'lendi → sonraki dalga güncellenmiş base'den türer (D otomatik)

if allFailed.length === 0 && allSkipped.length === 0:
   await deps.manager.push(session)
   body = "Tamamlanan task'lar:\n" + board.list().map(c => `- ${c.title}`).join("\n")
   pr = await deps.manager.openPR(session, deps.prAdapter,
          { base: opts.fromBranch, title: opts.prTitle ?? `hc: ${opts.jobName}`, body })
   return { status:"completed", session, pr, waves }
return { status:"partial", session, failed: allFailed, skipped: allSkipped, waves }
```

- **Bağımlı atlama transitive:** `blocked` hem failed hem skipped'i biriktirir → atlanan bir
  task'ın bağımlıları da atlanır.
- **PR yalnız tam başarıda:** herhangi failed/skipped varsa PR açılmaz, `{partial}` döner (G/insan devralır).
- **team-lead opts:** `resolve("team-lead")` + `ToolRegistry` + `buildSkillTool` (E-skills coupling),
  `cwd: session.baseWorktree`, `messages: []`.

---

## 4. Ön-kararlar (D/E2/E4a-b sözleşmesiyle)

- **Session açık kalır** (PR sonrası cleanup yok → G/H).
- **`askHuman` otonom varsayılan** (abandon) → motor insanı beklemez; H gerçek callback enjekte eder.
- **`escalation.rounds` deps'ten** (F/main config'ten kurar; `runWaveTask` `Math.max(1,…)` clamp'ler).
- **PRAdapter enjekte** (gerçek MCP → G); `push`→`openPR`.
- **Council-throw'da `abortMerge`** (E4b notu #3) — `wrap` sarmalayıcısında.

---

## 5. Test Stratejisi

**İçerik-tabanlı deterministik provider (paralellik için şart):** `MockProvider` global index'iyle
paralel task'lar interleave olur → nondeterministik. Bunun yerine testler **isteğe göre yanıtlayan**
bir provider kullanır: system prompt (rol) + mesajdaki task başlığına bakıp yanıt üretir — böylece
interleaving önemsizdir.
- `P-router` → `submit {role:"coder"}`; `P-architect` → `submit {rootCause,plan}`;
  `P-reviewer` → task başlığı `failTasks`'te mi? `fail` : `pass`; diğer (coder/senior) → no-op `[text, stop]`.
- team-lead istekleri yanıtlanmaz (submit yok) → `runTeamLead` deterministik `computeWaves(board)`'a düşer
  → dalgalar board `deps`'inden gelir.

Gerçek tmp git repo (`initTmpRepo` + `WorktreeManager`) + gerçek `Board`.

- **createMutex:** eşzamanlı çağrılar sıralı koşar (örtüşme yok); sonuç/hata aynen döner.
- **runWaveTask.resolveConflict seam'i (stub manager):** `mergeTask` conflict → `resolveConflict`
  `{merged}` dönerse `runWaveTask` `{merged}`; `{conflict}` dönerse `{conflict}`; `resolveConflict`
  yoksa `{conflict}` (geriye dönük). E4a mevcut testleri yeşil.
- **runWave all-pass (paralel):** deps'siz 2 task tek dalgada → ikisi de `merged`, `skipped=[]`.
- **runWave one-fail:** `failTasks=[t1 başlık]` → t1 `failed`, t2 `merged`.
- **runWave skip:** `blocked={t1}`, t3.deps=[t1] → t3 `skipped` (koşmaz).
- **runWaveEngine completed:** t1(no-dep), t2(dep t1) → waves `[[t1],[t2]]`; hepsi pass →
  `push` çağrıldı, `prAdapter.createPR` çağrıldı, `{completed, pr.url}`.
- **runWaveEngine partial:** t1 fail → t2(dep t1) skip → `prAdapter.createPR` **çağrılmadı**,
  `{partial, failed:[t1], skipped:[t2]}`.
- **abort:** pre-aborted signal → `runWaveEngine` fırlatır (yutulmaz).

Tümü `vitest`, TDD, gerçek fs+git + içerik-tabanlı provider + fake `PRAdapter`.

---

## 6. E4c DIŞI (bilinçli ertelenen)

- **`closeSession`/cleanup, coach raporu** → G/H.
- **Gerçek MCP PRAdapter + config okuma** → G / F-main.
- **delete/modify conflict deterministik gate'i** (E4b notu #2) → F/G sertleştirme.
- **Gerçek role prompt içerikleri** → F/G.

---

## 7. Açık Noktalar / İleride

- `resolveConflict` merge kilidi içinde koştuğundan yavaş bir conflict çözümü diğer merge'leri
  bloklar — doğru (D sözleşmesi) ve conflict nadir; sorun değil.
- `{partial}` sonrası base worktree'de kısmen landed işler durur (session açık) → G revision veya
  insan devralır; hangi task'ların land ettiği `board` kolonlarından + `merged`/`failed`/`skipped`
  listelerinden okunur.
- Bir dalgadaki task fırlatırsa (abort dışı beklenmedik hata) `Promise.all` reject → motor durur;
  gerekirse ileride task-seviyesi izolasyon (per-task catch) eklenebilir.
