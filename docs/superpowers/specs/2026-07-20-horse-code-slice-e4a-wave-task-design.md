# horse-code Dilim E4a — Task-in-Wave Yaşam Döngüsü Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.3 worktree & dalga merge)
**Üst dilim:** E4 (dalga motoru). E4a = **tek task'ın** derive→escalate→merge birimi.

---

## 1. Amaç ve Kapsam

Bir task'ı dalga içinde uçtan uca koşan birim `runWaveTask`: base'den izole task worktree'si
**türet** (`deriveTask`) → task'ı escalation merdiveniyle worktree'de **koş**
(`runTaskWithEscalation`, E3b) → task geçerse worktree değişikliklerini task branch'ine
**commit**le (`commitTask`, bu dilimde D'ye eklenir) → base'e **merge** (`mergeTask`, D). Sonuç bir
union: `merged` / `conflict` / `task-failed`.

> **Neden commit E4a'da:** E3 (escalation) worktree'ye yazar ama **commit etmez** (üst-tasarım
> §5.4: "commit → E4"; reviewer commit'siz worktree'yi okur). `mergeTask = git merge task.branch`
> yalnızca **commit'lenmiş** değişiklikleri taşır; commit olmadan merge no-op olur ve base boş kalır.
> Bu yüzden E4a, escalation geçtikten sonra merge'den önce task worktree'sini commit'ler.

**Tüketir (tamam):** D — `WorktreeManager` (`deriveTask`, `mergeTask`), `WorktreeSession`,
`TaskWorktree`, `MergeResult`; E3b — `runTaskWithEscalation`, `EscalationDeps`; E1 — `Board`.
**Ekler (bu dilim):** D `WorktreeManager`'a `commitTask(task, message)` (task worktree'sindeki tüm
değişiklikleri task branch'ine commit'ler; değişiklik yoksa no-op).

Konum: `src/engine/wave-task.ts` (E2/E3 ile aynı dizin).

### Kapsam DIŞI (E4a değil)
- **Conflict çözümü** (conflict-council, `commitMerge`/`abortMerge`) → **E4b**. E4a conflict'i
  yalnızca `{status:"conflict", files}` olarak **yüzeye çıkarır**.
- **Dalga orkestrasyonu** (dalga içi paralellik, dalgalar-arası bariyer, `openSession`,
  `runTeamLead`, `push`/`openPR`) → **E4c**.
- **Worktree temizliği** (`removeTask`/`closeSession`) → **E4c/G/H**. E4a temizlik yapmaz; task
  worktree'leri (başarılı/başarısız) session sonuna kadar kalır.

---

## 2. Ortak Bağımlılık Paketi + Sonuç Tipi

```typescript
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";

/** E4a yalnızca bu üç metodu kullanır (stub/mock enjeksiyonu için dar arayüz). */
export type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">;

export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  /** Git-mutating adımları (derive, merge) serileştiren mutex; paralel dalgada E4c sağlar.
   *  Varsayılan: kimlik (tek task testinde/sıralı çalışmada aynen çalışır). */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type TaskResult =
  | { status: "merged"; task: TaskWorktree }
  | { status: "conflict"; files: string[]; task: TaskWorktree }
  | { status: "task-failed"; task: TaskWorktree };
```

> **`serialize` seam'i neden E4a'da:** task'lar izole worktree'lerde **paralel** koşar (yavaş LLM
> kısmı), ama `git worktree add` (derive) ve `git merge` (base'e) **paylaşımlı repo/base worktree'ye**
> dokunur → yarış (index.lock, D'nin "önceki merge resolve/abort edilmeden ikincisi çağrılmaz"
> sözleşmesi). E4a bu iki adımı `serialize` içinden geçirir; escalation'ı geçirmez. E4c gerçek
> mutex'i enjekte eder; E4a testi ve sıralı çalışma varsayılan kimlikle doğrudur.

---

## 3. `runWaveTask(deps, session, board, taskId): Promise<TaskResult>`

```
card = board.get(taskId)                         (yoksa hata)
ser  = deps.serialize ?? ((f) => f())
tw   = await ser(() => deps.manager.deriveTask(session, card.title))   // base'den izole worktree

rounds = Math.max(1, deps.rounds)                 // E3b M2: rounds<1 → 1 (cheap tier'ları atlama)
v = await runTaskWithEscalation({ ...deps, rounds }, board, taskId, tw.worktree)

if v.verdict === "fail":                          // abandon → commit/merge YOK
   board.appendStage(taskId, { role: "team-lead", action: "task-failed" })
   return { status: "task-failed", task: tw }

// pass → worktree değişikliklerini task branch'ine commit'le, sonra merge et
await deps.manager.commitTask(tw, `hc: ${card.title}`)   // değişiklik yoksa no-op
mr = await ser(() => deps.manager.mergeTask(session, tw))
if mr.status === "merged":                         // temiz merge zaten commit'li → commitMerge YOK
   board.appendStage(taskId, { role: "team-lead", action: "merged" })
   return { status: "merged", task: tw }

// conflict → yüzeye çıkar (çözüm E4b)
board.appendStage(taskId, { role: "team-lead", action: "merge-conflict", note: mr.files.join(", ") })
return { status: "conflict", files: mr.files, task: tw }
```

**Notlar:**
- `runTaskWithEscalation` kartın `worktree`'sini kendi içinde `setWorktree(taskId, cwd)` ile
  `tw.worktree`'ye ayarlar (E3b) ve kartı kolonlar arası taşır (pass→DONE, abandon→REVIEW/TODO).
  E4a yalnızca **merge kararını + audit stage'lerini** ekler.
- **`{status:"merged"}` sonrası `commitMerge` çağrılmaz** — `git merge` temiz durumda otomatik
  commit'ler (D final-review notu #2). `commitMerge` yalnızca conflict çözümü sonrası (E4b).
- **task-failed'de base'e dokunulmaz** — worktree'deki yarım iş base'e sızmaz; task worktree
  incelenmek üzere durur. Dalga kaderi (iptal/devam/bağımlıları blokla) E4c'de.
- **Abort:** `runWaveTask` try/catch içermez; `runTaskWithEscalation`/`mergeTask` throw'u yukarı
  propagate eder (E0/E2/E3 dersi). `deriveTask` git adımıdır (signal-aware değil); pre-aborted
  sinyalde derive koşar, sonra escalation fırlatır.

---

## 4. Test Stratejisi

Gerçek tmp git repo (`test/worktree/helpers.js` → `initTmpRepo()`) + gerçek `WorktreeManager` +
`MockProvider` (escalation turn'leri) + gerçek `Board`. Roller: router, coder, senior-coder,
architect, code-reviewer (E3b'deki gibi).

- **`commitTask` (gerçek git):** `deriveTask` → task worktree'ye dosya yaz → `commitTask` →
  task branch'inde yeni commit var (`git log`); değişiklik yokken `commitTask` no-op (hata yok).
- **merged (gerçek git):** `initTmpRepo` → `openSession("main","job")` → board 1 task →
  MockProvider: router(coder) → implementer `write_file(out.txt)` → done → reviewer pass →
  `runWaveTask` → `{status:"merged"}`; **base worktree'de `out.txt` var** (commit + merge oldu);
  kart DONE. (commit olmasa merge no-op olurdu → bu test commit adımını da doğrular.)
- **task-failed (gerçek git):** `rounds=1`, escalation abandon'a kadar script'lenir
  (coder fail → senior-coder fail → konsey: architect submit + senior write + reviewer fail),
  `askHuman → abandon` → `runWaveTask` → `{status:"task-failed"}`; **base worktree'de değişiklik
  YOK** (merge olmadı); dönen `task` tanımlı.
- **conflict relay (stub manager):** `deriveTask` gerçek yazılabilir tmp dizin döndüren,
  `commitTask` no-op, `mergeTask` `{status:"conflict", files:["shared.txt"]}` döndüren stub
  `WaveTaskManager`.
  Escalation başarıyla geçer (implementer stub worktree'ye yazar), merge conflict döner →
  `runWaveTask` `{status:"conflict", files:["shared.txt"]}` **relay** eder; stage `merge-conflict`.
  (Gerçek git conflict'i çok-task olgusudur → E4c/E4b'de doğal doğrulanır; E4a yalnızca relay'i test eder.)
- **rounds clamp:** `rounds=0` + tier0 coder pass → `{status:"merged"}` (clamp `1` olmasa
  `tierOf(0,0)=2` ile doğrudan konseye giderdi; coder'ın koştuğunu system-prompt ile doğrula).
- **abort:** pre-aborted signal + stub manager → `runWaveTask` **rejects** (escalation fırlatır, yutulmaz).
- **bilinmeyen task:** `board.get` undefined → hata.

Tümü `vitest`, TDD; merged/task-failed gerçek fs+git, conflict/abort stub manager.

---

## 5. E4a DIŞI (bilinçli ertelenen)

- **Conflict-council + `commitMerge`/`abortMerge`** → E4b.
- **`openSession`/`runTeamLead`/dalga döngüsü/`push`/`openPR`/gerçek mutex** → E4c.
- **`removeTask`/`closeSession` temizliği** → E4c/G/H.
- **Gerçek `askHuman` (terminal) + config'ten `escalation.rounds` okuma** → H / E4c.

---

## 6. Açık Noktalar / İleride

- `serialize` varsayılan kimlik → E4a tek başına paralel-güvenli değil; paralel-güvenliği E4c
  gerçek mutex'i enjekte ederek sağlar (task worktree izolasyonu zaten paralel LLM'i güvenli kılar).
- task-failed'de kartın hangi kolonda kaldığı E3b'ye bağlı (abandon → REVIEW; M1). E4c dalga
  bookkeeping'i kartın kolonuna değil `TaskResult.status`'a bakmalı (E3b M1 notuyla tutarlı).
- Conflict `files` listesi D'nin `git diff --diff-filter=U` çıktısından gelir; E4b bu listeyi
  çözecek dosya kümesi olarak tüketir.
