# horse-code Dilim D — Worktree Manager Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.3 worktree hiyerarşisi, §11 Dilim D)

---

## 1. Amaç ve Kapsam

Bu dilim, paralel kodlamanın izolasyon altyapısını inşa eder: **`WorktreeManager`** — session ana
worktree'sini açar, her task için ondan türev worktree üretir, dalga sonunda task branch'lerini
base'e merge eder (çakışmayı açığa çıkarır), temizler, ve base'i push edip enjekte bir adaptörle
PR açar. Saf git mekaniği; role-agent/council/pipeline orkestrasyonu YOK (o Dilim E).

**Tüketir:** yalnızca `git` (child_process) ve dosya sistemi. Diğer dilimlere bağımlı değil
(D, C'den bağımsızdır; E ikisini de tüketir).

**İki katmanlı worktree hiyerarşisi (design doc §5.3):**
```
kullanıcının seçtiği branch
   └─► SESSION ANA WORKTREE (openSession, temiz)   base branch: hc/<job-slug>/base
          ├─► task worktree (deriveTask)   branch: hc/<job-slug>/t/<task-slug>
          ├─► task worktree ...
          └─ dalga sonu → task branch'leri base'e merge (mergeTask)
```

> **Git ref D/F kısıtı:** `hc/<job-slug>` (base) + `hc/<job-slug>/<task-slug>` (task) git'te
> AYNI ANDA var olamaz (`refs/heads/hc/<slug>` dosya, `.../<slug>/<task>` dizin gerektirir → çakışır).
> Bu yüzden base branch `hc/<job-slug>/base`, task branch'leri `hc/<job-slug>/t/<task-slug>` —
> hepsi `hc/<job-slug>/` namespace'i altında, D/F çakışması yok (`base` dosyası ile `t` dizini kardeş).

---

## 2. Konum ve İsimlendirme

```
<repoRoot>/.horsecode/worktrees/<job-slug>/base            (branch: hc/<job-slug>/base)
<repoRoot>/.horsecode/worktrees/<job-slug>/tasks/<task-slug>   (branch: hc/<job-slug>/t/<task-slug>)
```
> Klasör adları D/F kısıtından etkilenmez (yalnızca branch ref'leri); branch'ler `hc/<job-slug>/base`
> ve `hc/<job-slug>/t/<task-slug>` namespace'iyle çakışmayı önler (bkz. §1).

- **Slug:** çağıran (coach/project-manager) kısa açıklayıcı bir ad verir; `WorktreeManager` onu
  **kebab-case + filesystem-güvenli** slug'a çevirir (küçük harf, `[a-z0-9]` dışı → `-`, tekrar/
  baş-son `-` sadeleştirilir) ve **çakışmada `-2`, `-3` ile tekilleştirir** (disk kontrolü).
- **gitignore:** `openSession` `.horsecode/worktrees/.gitignore` dosyasını (`*`) yazarak worktree
  içeriklerinin ana repo `git status`'ında görünmesini engeller. (Ana repo `.horsecode/config.json`
  gibi commit'lenebilir dosyalar etkilenmez — yalnızca `worktrees/` altı ignore edilir.)

---

## 3. Arayüz

```typescript
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface WorktreeSession {
  jobSlug: string;
  root: string;         // <repoRoot>/.horsecode/worktrees/<jobSlug>
  baseWorktree: string; // <root>/base
  baseBranch: string;   // hc/<jobSlug>/base
}

export interface TaskWorktree {
  taskSlug: string;
  worktree: string;     // <root>/tasks/<taskSlug>
  branch: string;       // hc/<jobSlug>/t/<taskSlug>
}

export type MergeResult = { status: "merged" } | { status: "conflict"; files: string[] };

export interface PRInput { base: string; title: string; body: string }
export interface PRAdapter {
  createPR(input: { branch: string } & PRInput): Promise<{ url: string; number?: number }>;
}

export class WorktreeManager {
  constructor(deps: { repoRoot: string; runGit?: GitRunner });

  openSession(fromBranch: string, jobName: string): Promise<WorktreeSession>;
  deriveTask(session: WorktreeSession, taskName: string): Promise<TaskWorktree>;
  mergeTask(session: WorktreeSession, task: TaskWorktree): Promise<MergeResult>;
  commitMerge(session: WorktreeSession, message?: string): Promise<void>;
  abortMerge(session: WorktreeSession): Promise<void>;
  removeTask(session: WorktreeSession, task: TaskWorktree): Promise<void>;
  push(session: WorktreeSession, remote?: string): Promise<void>;
  openPR(session: WorktreeSession, adapter: PRAdapter, input: PRInput): Promise<{ url: string }>;
  closeSession(session: WorktreeSession): Promise<void>;
}
```

`runGit` varsayılan implementasyonu `git`'i `child_process.spawn` ile çalıştırır (shell tool
desenine benzer, `{stdout, stderr, code}` toplar). Enjekte edilebilir → testler hata yollarını
(nonzero exit) simüle edebilir; ama happy path gerçek `git` ile koşar.

---

## 4. Davranış (git komutları)

| Metot | Yaptığı |
|-------|---------|
| **openSession(fromBranch, jobName)** | `jobName`→`jobSlug` (sanitize+dedupe); `mkdir -p root/tasks`; `.horsecode/worktrees/.gitignore` yaz; `git worktree add -b hc/<jobSlug>/base <baseWorktree> <fromBranch>`. `WorktreeSession` döner. |
| **deriveTask(session, taskName)** | `taskName`→`taskSlug` (session içinde dedupe); `git worktree add -b hc/<jobSlug>/t/<taskSlug> <taskWorktree> <baseBranch>` — base branch'in **güncel HEAD'inden** dallanır. `TaskWorktree` döner. |
| **mergeTask(session, task)** | `baseWorktree`'de `git merge <task.branch>`. Başarı (ff veya temiz merge) → `{status:"merged"}`. Çakışma (nonzero exit) → **merge'i olduğu gibi bırak** (conflict marker'lar dosyada), `git diff --name-only --diff-filter=U` ile çakışan dosyaları topla → `{status:"conflict", files}`. |
| **commitMerge(session, message?)** | `baseWorktree`'de `git add -A` + `git commit --no-edit` (veya `-m message`). Konsül çözdükten sonra E çağırır. |
| **abortMerge(session)** | `baseWorktree`'de `git merge --abort`. Çözülemezse E çağırır → base temiz döner. |
| **removeTask(session, task)** | `git worktree remove --force <taskWorktree>`; `git branch -D <task.branch>`. |
| **push(session, remote="origin")** | `baseWorktree`'de `git push <remote> hc/<jobSlug>/base`. |
| **openPR(session, adapter, input)** | `adapter.createPR({ branch: session.baseBranch, base: input.base, title, body })` → `{url}`. |
| **closeSession(session)** | tüm task worktree'leri + base worktree'yi `git worktree remove --force`; `git worktree prune`; `git branch -D` (session branch'leri); `root` dizinini sil. |

**Türev semantiği (kritik):** `deriveTask` her zaman `baseBranch`'in **o anki HEAD'inden** dallanır.
Bir dalga `mergeTask`+`commitMerge` ile base'i ilerlettiğinde, **sonraki dalganın** `deriveTask`
çağrıları otomatik güncellenmiş base'i alır — design doc'taki "sonraki dalga güncellenmiş base'den
türer" bedavaya gelir. Dalga döngüsünü (hangi task ne zaman) **E sürer**, D değil.

**Çakışma → E→council sınırı:** `mergeTask` çakışmada base worktree'yi **merge-durumunda**
(conflict marker'larla) bırakır ve çakışan dosyaları raporlar. Git ikinci bir merge'e izin
vermediğinden dalga bu noktada **durur**; E çakışmayı bir **conflict-resolution council**'e
(role-agent'lar, Dilim C loop'u) verir, dosyalar çözülünce `commitMerge`, çözülemezse `abortMerge`
+ eskalasyon. Council'ün kendisi D'de DEĞİL.

---

## 5. Test Stratejisi

Gerçek geçici git repo üzerinde (headless, B2'nin tmp-FS deseniyle tutarlı):

- **`initTmpRepo` yardımcı:** `mkdtemp` → `git init` → `git config user.*` → bir dosya + initial
  commit → seçilen kaynak branch (ör. `main`). (Test yardımcısı, `test/` altında.)
- **openSession:** worktree dizini + `hc/<slug>` branch oluştu; dönen yollar doğru; `.gitignore` yazıldı.
- **slug dedupe:** aynı `jobName` ile iki kez → ikincisi `<slug>-2`.
- **deriveTask:** task worktree + `hc/<slug>/<task>` branch base HEAD'inden; farklı task'lar izole.
- **mergeTask (merged):** task worktree'de dosya yaz+commit → `mergeTask` → `{merged}`, base worktree'de dosya var.
- **mergeTask (conflict):** iki task base'den türe, ikisi aynı dosyayı farklı değiştir+commit; birinciyi merge (ff/temiz), ikinciyi merge → `{conflict, files:["x"]}`; base worktree merge-durumunda; `git diff --diff-filter=U` çakışmayı gösterir.
- **commitMerge:** çakışan dosyayı elle çöz (marker'ları sil) + `commitMerge` → merge tamamlanır, temiz.
- **abortMerge:** çakışma sonrası `abortMerge` → base temiz, önceki merge yok.
- **push:** `git init --bare` tmp bare remote'u `origin` ekle → `push` → bare remote'ta `hc/<slug>` ref'i var.
- **openPR:** fake `PRAdapter` → `createPR` doğru `{branch, base, title, body}` ile çağrıldı, `{url}` döndü.
- **removeTask / closeSession:** worktree'ler + branch'ler silindi, `git worktree list` temiz.
- **runGit enjeksiyonu:** hata (nonzero exit) → ilgili metot net hata fırlatır.

Tümü `vitest`, TDD.

---

## 6. Dilim D DIŞI (bilinçli ertelenen)

- **Gerçek MCP PR wiring** (GitHub vs Azure DevOps sağlayıcı seçimi, auth) → sonraki entegrasyon
  dilimi. D yalnızca enjekte `PRAdapter` kontratını sunar; gerçek adaptör sonra yazılır.
- **Conflict-resolution council** (role-agent'larla çözüm) → Dilim E. D çakışmayı yalnızca açığa çıkarır.
- **Dalga döngüsü orkestrasyonu** (team-lead, bağımlılık grafiği, hangi task hangi dalgada) → Dilim E.
- **Revision akışı:** senior-coder base worktree'de doğrudan çalışır (yeni worktree yok) — D
  `baseWorktree` yolunu zaten verir; özel destek gerekmez. Orkestrasyon Dilim G.

---

## 7. Açık Noktalar / İleride

- `git merge` varsayılan (ff-mümkünse). Her task merge'ini ayrı commit olarak izlemek istenirse
  ileride `--no-ff` seçeneği eklenebilir (audit trail için); MVP'de varsayılan.
- `PRAdapter`'ın gerçek MCP implementasyonu remote/branch tespitini (GitHub mı Azure mı) nereden
  alacak — repo remote'undan mı, config'ten mi — o dilimde kararlaşır (design doc §12 açık notu).
- Eşzamanlı iki session (aynı repo) — slug dedupe dizin çakışmasını çözer; git worktree kilitleri
  git'in kendi güvencesinde.
