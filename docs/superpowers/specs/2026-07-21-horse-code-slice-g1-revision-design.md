# horse-code Dilim G1 — Revision Pipeline (Mantık) Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§7 PR review, §8 revision)
**Üst dilim:** G (revision pipeline). G1 = adapter-agnostik revision mantığı (gerçek adapter G2).

---

## 1. Amaç ve Kapsam

PR açıldıktan sonraki **revision döngüsü**: **principal-coder** base worktree'deki (merge sonrası)
değişiklikleri review eder → onaylar | değişiklik ister. Değişiklikte: yorumlar `postComments`
seam'iyle işlenir + **senior-coder ana worktree'de** (izole değil) düzeltir → commit + push →
re-review. Döngü **≤N tur** (varsayılan 3); son turda hâlâ bulgu → principal-coder **son karar**
(kabul | insana sor). Adapter-agnostik: `postComments`/`askUser` seam; gerçek gh/az → G2.

**Tüketir (tamam):** E0 `runStructuredRole`; C `runToCompletion`; E3a `readOnlyRegistry`,
`TaskCycleDeps`; B2 `createDefaultRegistry`; E-skills `buildSkillTool`; D `WorktreeManager`
(`commitMerge`, `push`), `WorktreeSession`; E1 `Board`; F2 `AskUser`; H2 `REQUIRED_ROLES`/`DEFAULT_PROMPTS`.

Konum: `src/engine/revision.ts` (runRevision + şemalar); `src/prompts.ts` (principal-coder eklenir).

### Kapsam DIŞI (G1 değil)
- **Gerçek PR adapter (gh/az createPR/postComments), platform tespiti, runJob entegrasyonu** → G2.
- **Board'a PR diff'inin gerçek çekilmesi** — G1 principal-coder base worktree'yi read tool'larla inceler (PR = merge edilmiş base).
- **Gerçek terminal askUser** → H (G1 scripted).

---

## 2. principal-coder Rolü (prompts.ts)

`REQUIRED_ROLES`'e `"principal-coder"` eklenir; `DEFAULT_PROMPTS["principal-coder"]` işlevsel
varsayılan: "PR'daki tüm değişiklikleri (base worktree) bütünsel review et. Yeterliyse approve;
değilse request-changes + somut comment'ler. Son karar turunda accept veya ask-human." (H2 wiring
zaten config.model + DEFAULT_PROMPTS ile çözer — ek wiring gerekmez.)

---

## 3. Bağımlılık Paketi + Tipler

```typescript
export interface RevisionDeps extends TaskCycleDeps {
  manager: Pick<WorktreeManager, "commitMerge" | "push">;
}
export type PostComments = (comments: string[]) => Promise<void>;

export const PrincipalReviewSchema = z.object({
  decision: z.enum(["approve", "request-changes"]),
  comments: z.array(z.string()),
});
export const PrincipalFinalSchema = z.object({
  decision: z.enum(["accept", "ask-human"]),
  question: z.string(),
});

export type RevisionResult =
  | { status: "approved"; rounds: number }              // principal onayladı (rounds = yapılan revizyon sayısı)
  | { status: "accepted"; rounds: number }              // son turda principal kabul etti
  | { status: "human"; rounds: number; answer: string }; // insana soruldu, cevap alındı
```

`JobDeps` (H1) `RevisionDeps`'i sağlar (manager tam WorktreeManager).

---

## 4. `runRevision(deps, session, board, postComments, askUser, maxRounds): Promise<RevisionResult>`

```
board.addCard({ id: "revision", title: "PR revision" })        // audit kartı

for round in 1..maxRounds:
   v = await principalReview(deps, session.baseWorktree)         // {decision, comments}
   if v.decision === "approve":
      appendStage(revision, principal-coder, "pr:approved")
      return { status: "approved", rounds: round - 1 }

   if round === maxRounds:                                       // son turda hâlâ bulgu → son karar
      appendStage(revision, principal-coder, "pr:changes", comments)
      f = await principalFinal(deps, session.baseWorktree)       // {decision, question}
      if f.decision === "accept":
         appendStage(revision, principal-coder, "pr:final:accept")
         return { status: "accepted", rounds: maxRounds }
      answer = await askUser(f.question)
      appendStage(revision, human, "pr:human", answer)
      return { status: "human", rounds: maxRounds, answer }

   // henüz son tur değil → düzelt
   appendStage(revision, principal-coder, "pr:changes", comments)
   await postComments(v.comments)                                // seam: gerçek PR'a yorumlar (G2)
   await seniorRevise(deps, session.baseWorktree, v.comments)    // senior ana worktree'de düzeltir
   appendStage(revision, senior-coder, "pr:revised")
   await deps.manager.commitMerge(session, `hc: revision ${round}`)   // düzeltmeleri baseBranch'e
   await deps.manager.push(session)                              // PR'ı güncelle
```

**Alt-birimler:**
- **`principalReview(deps, base)`:** `resolve("principal-coder")` + `readOnlyRegistry(deps)` (cwd=base)
  + mesaj "base worktree'deki değişiklikleri review et; approve veya request-changes + comments" →
  `runStructuredRole(opts, PrincipalReviewSchema)`.
- **`principalFinal(deps, base)`:** `resolve("principal-coder")` + `readOnlyRegistry` + mesaj
  "SON KARAR: N tur sonra hâlâ bulgu var; accept veya ask-human + soru" → `runStructuredRole(opts,
  PrincipalFinalSchema)`. ("SON KARAR" marker'ı review'dan ayırır.)
- **`seniorRevise(deps, base, comments)`:** `resolve("senior-coder")` + `createDefaultRegistry()` +
  `buildSkillTool` (tam tool'lar — ana worktree'de düzeltir, test koşabilir) + mesaj "Şu PR
  yorumlarını gider (fix et veya 'by design' gerekçele): `<comments>`. Ana worktree'de çalış." →
  `runToCompletion`. cwd=base.

- **Abort:** try/catch yok; `runStructuredRole`/`runToCompletion`/manager throw'u propagate eder.

---

## 5. Test Stratejisi

**İçerik-tabanlı provider** (principal-coder review vs final, senior-coder) + gerçek tmp base
worktree (senior gerçek dosya yazar) + fake `manager` (commitMerge/push kaydeder) + fake
`postComments`/`askUser`.

- **onay ilk turda:** principal review → approve → `{status:"approved", rounds:0}`; senior/postComments çağrılmaz.
- **bir revizyon → onay:** review1 request-changes → `postComments(comments)` çağrıldı + senior
  base worktree'ye yazdı + `commitMerge`+`push` çağrıldı → review2 approve → `{status:"approved", rounds:1}`.
- **maxRounds → accept:** maxRounds=2, principal hep request-changes → round1 revize, round2 son
  karar → final accept → `{status:"accepted", rounds:2}`.
- **maxRounds → insana sor:** maxRounds=1, review1 request-changes → son karar ask-human →
  `askUser(question)` → "tamam" → `{status:"human", rounds:1, answer:"tamam"}`.
- **audit:** REVISION kartı stageHistory'de `pr:approved`/`pr:changes`/`pr:revised`/`pr:final:*` içerir.
- **abort:** pre-aborted → fırlatır.

Tümü `vitest`, TDD, içerik-provider + gerçek fs (tmp base worktree) + fake manager/seam'ler.

---

## 6. G1 DIŞI (bilinçli ertelenen)

- **Gerçek gh/az PR adapter (createPR/postComments), platform tespiti** → G2.
- **runJob entegrasyonu (runWaves completed → runRevision; stub adapter'ı gerçeğiyle değiştir)** → G2.
- **Gerçek terminal askUser** → H.
- **Rafine principal-coder/senior-coder revision prompt'ları** → G/ileride.

---

## 7. Açık Noktalar / İleride

- principal-coder PR'ı base worktree'yi okuyarak review eder (PR = merge edilmiş base); G2'de gerçek
  PR diff'i/thread'leri adapter'dan da beslenebilir.
- senior-coder "by design" gerekçesi ajanın çıktısında; yapısal thread-kapatma (resolve) G2/ileride.
- `maxRounds` param (varsayılan 3); config `revision.rounds` ileride.
- Revizyon commit'leri `commitMerge` (git add -A) — base worktree'de yalnız senior'ın düzeltmeleri
  olmalı; başka kirlilik varsa birlikte commit'lenir (H1 spec/plan commit'i zaten yapıldı).
