# horse-code Dilim E4b — Conflict-Resolution Council Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.3; roadmap E4)
**Önceki dilimler:** E4a (`runWaveTask` → `{status:"conflict", files, task}`), E3b (escalation konseyi paterni), D (`WorktreeManager`).

---

## 1. Amaç ve Kapsam

E4a bir task'ı base'e merge ederken çakışma çıkarsa (`{status:"conflict"}`) base worktree
**merge-ortasında** kalır (`MERGE_HEAD` + conflicted dosyalar). E4b bu çakışmayı bir **konseyle**
çözer: architect neden çakıştığını analiz eder → senior-coder base worktree'de çözer →
code-reviewer sonucu doğrular → `commitMerge`. `N` tur denemeden sonra çözülemezse `abortMerge`
+ **insana sor** (retry/abandon).

**Tüketir (tamam):** D — `WorktreeManager` (`commitMerge`, `abortMerge`), `WorktreeSession`,
`TaskWorktree`; E3b — `EscalationDeps`, `AskHuman`, `runReviewer` (E3a); E0 — `runStructuredRole`;
konsey — `ArchitectPlanSchema` (E3b `council.ts`); C — `runToCompletion`; B2 —
`ToolRegistry`/tool'lar (read/write/edit/grep/glob); E-skills — `buildSkillTool`; E1 — `Board`.
**Ekler (bu dilim):** D `WorktreeManager`'a `unmergedFiles(session): Promise<string[]>`
(base worktree'de git'in unmerged işaretlediği dosyalar; `git diff --name-only --diff-filter=U`).

Konum: `src/engine/conflict.ts`.

### Kapsam DIŞI (E4b değil)
- **E4a conflict → E4b çağrısı ve dalga orkestrasyonu** → **E4c**. E4b, mid-merge bir session +
  task alır; kim çağırdığını bilmez.
- **Worktree cleanup** (`removeTask`/`closeSession`) → E4c.
- **Gerçek `askHuman` (terminal)** → H (E4b scripted callback ile test eder).

---

## 2. D Uzantısı — `unmergedFiles`

```typescript
/** Base worktree'de git'in unmerged (çakışık) işaretlediği dosyalar. */
async unmergedFiles(session: WorktreeSession): Promise<string[]> {
  const r = await this.git(["diff", "--name-only", "--diff-filter=U"], session.baseWorktree);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
```

(`mergeTask` bu mantığı zaten inline içeriyor; opsiyonel DRY refactor'ı E4b kapsamı dışında bırakılabilir.)

---

## 3. Bağımlılık Paketi + Sonuç Tipi

```typescript
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";

export interface ConflictDeps extends EscalationDeps {
  manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge">;
}

export type ConflictResult =
  | { status: "resolved" }
  | { status: "unresolved"; task: TaskWorktree };
```

`askHuman`, `rounds`, roller (architect/senior-coder/code-reviewer) `EscalationDeps`'ten gelir.

---

## 4. `runConflictCouncil(deps, session, board, taskId, task): Promise<ConflictResult>`

```
card = board.get(taskId)                    (yoksa hata)
conflicted = await deps.manager.unmergedFiles(session)   // çakışık dosyalar
rounds = Math.max(1, deps.rounds)

loop:
  for i in 1..rounds:
     # 1. architect diagnoz (salt-okunur toolset, cwd = session.baseWorktree)
     plan = runStructuredRole(resolve("architect"), ArchitectPlanSchema,
              msg="şu dosyalarda merge çakışması: <conflicted>. Kök-neden + çözüm planı."
                  + card.reviewNotes)                     → { rootCause, plan[] }
     appendStage architect "conflict:diagnosed" (note rootCause)

     # 2. senior-coder resolve (read/write/edit/grep/glob + buildSkillTool — SHELL YOK, cwd = base)
     runToCompletion(resolve("senior-coder"),
        msg="base worktree'de <conflicted> dosyalarındaki çakışmaları çöz (marker'ları kaldır,
             tutarlı birleşim). Plan: <plan>. <card.reviewNotes>")
     appendStage senior-coder "conflict:resolved-attempt"

     # 3. verify — deterministik marker taraması + code-reviewer
     markers = conflicted dosyalarından herhangi biri hâlâ "<<<<<<<" içeriyor mu (fs ile oku)
     if markers:
        board.addReviewNote(taskId, "çakışma marker'ları hâlâ var: <files>")
        continue                                          # attempt fail
     v = runReviewer(deps, card, session.baseWorktree)    # merge sonucu semantik kontrol
     if v.verdict == "pass":
        await deps.manager.commitMerge(session, `hc: conflict çözümü — ${card.title}`)
        appendStage code-reviewer "conflict:merged"
        return { status: "resolved" }
     # reviewer fail → sonraki attempt için not
     board.clearReviewNotes(taskId); for n of v.notes: board.addReviewNote(taskId, n)

  # rounds tükendi, base hâlâ mid-merge
  decision = await deps.askHuman({ card: board.get(taskId)!, verdict: { verdict: "fail", notes: ["merge conflict " + rounds + " turda çözülemedi"] } })
  if decision.action == "retry":
     board.clearReviewNotes(taskId); for n of decision.notes: board.addReviewNote(taskId, n)
     continue                                             # yeni rounds turu (hâlâ mid-merge)
  # accept veya abandon → abort (marker'lı/eksik commit olmaz)
  await deps.manager.abortMerge(session)
  appendStage "conflict:aborted"
  return { status: "unresolved", task }
```

**Notlar:**
- **Neden iki-katlı verify:** resolver marker'ı worktree'de kaldırır ama `git add` yapmaz →
  git'in unmerged durumu commit'e kadar sürer; `commitMerge` (`git add -A`) marker'lı dosyayı da
  stage'ler. Bu yüzden commit ÖNCESİ **deterministik marker taraması** (fs) leftover marker'ı
  yakalar; **code-reviewer** ise birleşimin tutarlılığını denetler. İkisi de geçmeden commit yok.
- **Retry mid-merge'de kalır:** `abortMerge` yalnızca abandon'da çağrılır. retry'de base merge-ortasında
  tutulur, konsey insan ipucuyla (reviewNotes) yeniden dener; re-merge gerekmez.
- **`accept` conflict'te geçersiz:** marker'lı/eksik birleşim commit'lenemez → `accept` de `abandon`
  gibi ele alınır (abort). Escalation'ın human seam'i (`AskHuman`) yeniden kullanılır.
- **reviewNotes = kanal:** architect/resolver mesajları `card.reviewNotes`'u içerir; reviewer-fail
  notları ve insan retry ipucu buradan sonraki denemeye taşınır.
- **Resolver'da shell yok:** resolver base worktree'de **mid-merge** çalışır; `shell` verilirse
  ajan kendi `git commit`/`git merge --abort` çalıştırıp E4b'nin merge kontrol akışını bozabilir.
  Toolset dosya düzenlemeyle sınırlı (read/write/edit/grep/glob + skill). architect salt-okunur,
  reviewer salt-okunur (E3a) — ikisi de zaten shell'siz.
- **Abort:** `runConflictCouncil` try/catch içermez; `runStructuredRole`/`runToCompletion`/git
  throw'u (abort dahil) yukarı propagate eder.

---

## 5. Test Stratejisi

**Gerçek çakışma** üretimi (`test/worktree/helpers.js` → `initTmpRepo` + `WorktreeManager`):
base'e `shared.txt="orig"` commit → aynı base'den `A` ve `B` türet → `A/shared.txt="AAA"` commit,
`B/shared.txt="BBB"` commit → `mergeTask(A)` merged → `mergeTask(B)` **conflict** → base mid-merge.
Sonra `runConflictCouncil` + `MockProvider` (architect submit → resolver `write_file(shared.txt, "MERGED")` → reviewer submit).

- **`unmergedFiles` (D):** yukarıdaki conflict kurulumunda `["shared.txt"]` döner; temiz merge sonrası `[]`.
- **resolved:** architect diagnoz → resolver marker'sız içerik yazar → reviewer pass →
  `commitMerge`; `unmergedFiles` sonrası `[]`, base commit'li (MERGE_HEAD yok), `{status:"resolved"}`,
  stage'ler `conflict:diagnosed`/`conflict:resolved-attempt`/`conflict:merged`.
- **marker kalırsa fail → retry:** resolver **marker bırakan** içerik yazar (ilk attempt) →
  deterministik tarama fail → reviewNotes eklenir; ikinci attempt marker'sız → resolved.
- **reviewer fail → retry:** marker yok ama reviewer `{verdict:"fail"}` → attempt fail; sonraki
  attempt reviewer pass → resolved; reviewNotes reviewer notlarını taşır.
- **N tükendi → abandon:** `rounds=1`, tek attempt fail → `askHuman` çağrıldı; `abandon` →
  `abortMerge` (base merge-öncesine döner, `unmergedFiles` `[]`, `MERGE_HEAD` yok) →
  `{status:"unresolved", task}`; stage `conflict:aborted`.
- **askHuman retry:** `rounds=1`, attempt1 fail → `askHuman` retry(ipucu) → attempt2 (ikinci
  architect mesajı ipucunu içerir) → resolved.
- **abort propagasyonu:** pre-aborted signal → `runConflictCouncil` fırlatır (yutulmaz).

Tümü `vitest`, TDD; gerçek fs+git + `MockProvider` (architect/resolver/reviewer turn'leri) + scripted `askHuman`.

---

## 6. E4b DIŞI (bilinçli ertelenen)

- **E4a `{conflict}` → E4b `runConflictCouncil` bağlantısı + dalga döngüsü/`push`/`openPR`** → E4c.
- **`removeTask`/`closeSession`** → E4c.
- **Gerçek `askHuman` terminal implementasyonu + config `rounds`** → H / E4c.
- **Conflict'e özel gerçek architect/resolver/reviewer prompt içerikleri** → F/G.

---

## 7. Açık Noktalar / İleride

- `unresolved` sonrası `task` branch'i + base'in mid-merge-öncesi durumu E4c'ye kalır; E4c bu
  task'ı re-derive mi eder yoksa task-failed mi sayar → E4c kararı.
- Çok dosyalı çakışmada marker taraması tüm `conflicted` listesini tarar; resolver bir dosyayı
  atlarsa deterministik tarama yakalar (commit engellenir).
- `rounds` escalation ile paylaşılan config değeri; conflict'e özel ayrı `N` gerekirse E4c/config'te
  ayrıştırılabilir (şimdilik tek değer).
