# horse-code Dilim E3b — Task-seviyesi Escalation Merdiveni Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.4 escalation)
**Önceki dilim:** E3a (`src/engine/task-cycle.ts` — tek-tur `runTaskCycle`)

---

## 1. Amaç ve Kapsam

E3a'nın **tek-tur** task döngüsünü (`route → implement → review → pass:DONE / fail:TODO+notes`)
çok-turlu **escalation merdiveniyle** sar. Bir task review'dan tekrar tekrar dönerse rol
yükselir: route edilen implementer → ailenin senior'ı → **escalation konseyi** (architect diagnoz +
senior implement + son review), konsey de çözemezse **insana sor**.

**Tüketir (tamam):** E3a — `runImplementer`, `runReviewer`, `routeTask`, `TaskCycleDeps`,
`Verdict`, `ImplementerRole` (`src/engine/`); E1 — `Board`/`Card` (`incrementAttempts`,
`reviewNotes`, `stageHistory`); E0 — `runStructuredRole`; E-skills — `RoleRegistry`
(skill enjeksiyonlu), `buildSkillTool`; C — `runToCompletion`.

Konum: `src/engine/` (E2/E3a ile aynı).

---

## 2. Merdiven & Tier Hesabı

`routeTask(deps, task)` **bir kez** çağrılır → **aile** belirlenir: `"coder"` | `"designer"`.
Sonra `attempts` (her fail'de `board.incrementAttempts` ile artar) tier'ı belirler. `N` = tier
başına tur sayısı (config, varsayılan **3**; E3b'de `deps.rounds`).

| tier | koşul | rol |
|------|-------|-----|
| 0 | `attempts < N` | route edilen implementer (`coder` \| `designer`) |
| 1 | `N ≤ attempts < 2·N` | ailenin senior'ı (`senior-coder` \| `senior-designer`) |
| 2 | `attempts ≥ 2·N` | **escalation konseyi** (aşağıda) |

**Aile → senior eşlemesi:** `coder → senior-coder`, `designer → senior-designer`.

**Tier fonksiyonu:**
```
tierOf(attempts, N) = attempts < N ? 0 : attempts < 2*N ? 1 : 2
```

Task döngüye `attempts = 0` (tier 0) ile girer. Her başarısız cycle `incrementAttempts` çağırır;
`attempts` `N`'e ulaşınca sonraki cycle tier 1, `2·N`'e ulaşınca tier 2 (konsey) olur. Konseyde
`retry` ile `attempts` artmaya devam eder ama tier 2'de kalır.

---

## 3. Birimler

### 3.1 `runCycleWithRole(deps, board, taskId, cwd, role)` — E3a'dan extract

E3a'daki `runTaskCycle` içinden **routing'siz** tek-tur çekirdek çıkarılır. Verilen açık `role`
ile: `move(IN-PROGRESS, role)` → `runImplementer(deps, role, card, cwd)` → `move(REVIEW, role)`
→ `runReviewer(deps, card, cwd)` → pass: `appendStage(reviewed:pass)` + `clearReviewNotes` +
`move(DONE, "code-reviewer")`; fail: `appendStage(reviewed:fail)` + `clearReviewNotes` +
`addReviewNote(each)` (boş notes → `["review başarısız (not verilmedi)"]` varsayılanı) +
`move(TODO, "code-reviewer")`. `Verdict` döner.

> `role` tipi genişler: `ImplementerRole` yerine `RunnableRole = "coder" | "designer" |
> "senior-coder" | "senior-designer"` (implementer olarak çalıştırılabilir tüm roller).
> `runImplementer`'ın `role` parametresi de `RunnableRole` alır (yalnızca `resolve(role)` +
> yeni-vs-dönen mesajı; rol adı stringi geçer, davranış aynı).

`runTaskCycle(deps, board, taskId, cwd)` = `route = routeTask(...); setWorktree; return
runCycleWithRole(deps, board, taskId, cwd, route)`. **E3a davranışı ve testleri değişmez.**

### 3.2 `runEscalationCouncil(deps, board, taskId, cwd, family)` — yeni (`council.ts`)

Merdivenin tepesi. `family: "coder" | "designer"`. Sıra:

1. **architect diagnoz:** `resolve("architect")`, salt-okunur toolset (read/grep/glob + skill).
   `runStructuredRole(opts, ArchitectPlanSchema)` →
   `{ rootCause: string, plan: string[] }`. Mesaj: task title + `reviewNotes` + `stageHistory`
   özeti; "neden N+N tur takıldı, kök-neden + somut plan üret".
   `ArchitectPlanSchema = z.object({ rootCause: z.string(), plan: z.array(z.string()) })`.
2. **senior implement:** plan kartın `reviewNotes`'una yazılır
   (`clearReviewNotes` + `addReviewNote(rootCause)` + her `plan[]` adımı) → senior rolü
   (`family === "designer" ? "senior-designer" : "senior-coder"`) ile `move(IN-PROGRESS, senior)`
   + `runImplementer(deps, senior, card, cwd)` (E3a "dönen task" yolu: reviewNotes dolu). Ardından
   `move(REVIEW, senior)`.
3. **son review:** `runReviewer(deps, card, cwd)` → `Verdict`.
   `appendStage`: architect diagnozu (`action: "council:diagnosed"`, `note: rootCause`),
   senior implement (`action: "council:implemented"`), review sonucu.

`runEscalationCouncil` **konsey turunun** `Verdict`'ini döner (DONE'a taşımaz; insan kararı
`runTaskWithEscalation`'da). pass ise `appendStage(reviewed:pass)`; fail ise
`appendStage(reviewed:fail, note)`. Board `move` (DONE/insan) çağıran katmanda yapılır.

> **Konsey membership sadeleştirmesi:** Üst tasarım konseyi `{architect, coder, senior-coder}`
> diye anıyordu. E3b'de düz implementer (`coder`/`designer`) zaten tier 0'da başarısız oldu;
> konseyde **architect (diagnoz) + senior (implement) + code-reviewer (gate)** görev alır.
> Düz implementer ayrıca çağrılmaz — gücü senior'da toplandı.

### 3.3 `runTaskWithEscalation(deps, board, taskId, cwd)` — yeni (`escalation.ts`)

Dış döngü. `EscalationDeps = TaskCycleDeps & { rounds: number; askHuman: AskHuman }`.

```
task = board.get(taskId)            (yoksa hata)
family = await routeTask(deps, task)   // bir kez: coder | designer
board.setWorktree(taskId, cwd)
loop:
  attempts = board.get(taskId)!.attempts
  tier = tierOf(attempts, deps.rounds)
  if tier < 2:
     role = tier === 0 ? family : (family === "designer" ? "senior-designer" : "senior-coder")
     v = await runCycleWithRole(deps, board, taskId, cwd, role)
     if v.verdict === "pass": return v          // DONE (runCycleWithRole taşıdı)
     board.incrementAttempts(taskId)            // fail → tier ilerler
     continue
  else:  // tier 2 — konsey
     v = await runEscalationCouncil(deps, board, taskId, cwd, family)
     if v.verdict === "pass":
        board.clearReviewNotes(taskId); board.move(taskId, "DONE", "code-reviewer"); return v
     // konsey fail → insana sor
     decision = await deps.askHuman({ card: board.get(taskId)!, verdict: v })
     if decision.action === "accept":
        board.appendStage(taskId, { role: "human", action: "human:accept" })
        board.clearReviewNotes(taskId); board.move(taskId, "DONE", "human")
        return { verdict: "pass", notes: [] }
     if decision.action === "retry":
        board.appendStage(taskId, { role: "human", action: "human:retry", note: decision.notes.join("; ") })
        board.clearReviewNotes(taskId); for n of decision.notes: board.addReviewNote(taskId, n)
        board.incrementAttempts(taskId)         // tier 2'de kalır, konsey tekrar
        continue
     // abandon
     board.appendStage(taskId, { role: "human", action: "human:abandon" })
     return { verdict: "fail", notes: v.notes }  // TODO'da/REVIEW'da kalır, terminal fail
```

**Tipler (`escalation.ts` veya `task-types.ts`):**
```typescript
export type RunnableRole = "coder" | "designer" | "senior-coder" | "senior-designer";
export type HumanDecision =
  | { action: "accept" }
  | { action: "retry"; notes: string[] }
  | { action: "abandon" };
export type AskHuman = (ctx: { card: Card; verdict: Verdict }) => Promise<HumanDecision>;
export interface EscalationDeps extends TaskCycleDeps {
  rounds: number;              // tier başına tur; config escalation.rounds (varsayılan 3)
  askHuman: AskHuman;
}
```

**Abort:** `runCycleWithRole`/`runEscalationCouncil` içindeki `runToCompletion`/`runStructuredRole`
zaten E0/C'de abort'u `throw` eder (yutulmaz). `runTaskWithEscalation` bu hatayı yukarı bırakır —
döngüde `catch` ile fallback YOK.

---

## 4. Test Stratejisi

`MockProvider` (turn'ler global ilerler) + gerçek tmp worktree + `rounds` küçük (genelde `N=1`)
tutularak konseye hızlı ulaşılır.

- **tierOf birim testi:** `(0,1)→0, (1,1)→1, (2,1)→2, (2,3)→0, (5,3)→1, (6,3)→2`.
- **runCycleWithRole:** açık `senior-coder` rolü verilince `resolve("senior-coder")` çağrılır;
  pass→DONE, fail→TODO+notes (E3a çekirdeğiyle aynı). E3a `runTaskCycle` testleri yeşil kalır.
- **runTaskWithEscalation tier ilerlemesi (N=1):** cycle1 fail (coder) → cycle2 fail (senior-coder)
  → cycle3 konsey. Her turda `resolve` doğru rolle çağrıldı (istek loglarından doğrula);
  `attempts` her fail'de arttı.
- **designer ailesi:** route `{role:"designer"}` → tier1 `senior-designer`, konsey senior-designer
  implement eder.
- **konsey pass:** architect submit `{rootCause, plan:["..."]}` → senior write_file → reviewer
  submit `{verdict:"pass"}` → Board DONE + stageHistory `council:diagnosed`/`council:implemented`/
  `reviewed:pass`; senior implement mesajı architect planını (reviewNotes) içerir.
- **konsey fail → askHuman:** reviewer `{verdict:"fail"}` → `askHuman` çağrıldı.
  - `accept` → DONE + `human:accept`, `verdict:"pass"`.
  - `retry:["ipucu"]` → konsey tekrar koştu, ikinci architect mesajı "ipucu"yu içerir,
    `attempts` arttı.
  - `abandon` → `human:abandon`, `verdict:"fail"`, DONE'a taşınmadı.
- **abort:** pre-aborted `signal` → `runTaskWithEscalation` fırlatır (yutulmaz).

Tümü `vitest`, TDD, ağsız (MockProvider) + gerçek fs (tmp worktree).

---

## 5. E3b DIŞI (bilinçli ertelenen)

- **`askHuman`'ın gerçek terminal Q&A implementasyonu** → **H** (TUI). E3b seam + scripted callback.
- **`escalation.rounds`'un config'ten okunması/enjeksiyonu** → **E4** (deps'i caller kurar).
  E3b `deps.rounds`'u doğrudan alır.
- **Worktree oluşturma/merge, dalga yürütme** → **E4**. E3b var olan worktree yolu alır.
- **Konseyin paralel çok-üyeli assessment paterni** (§6 spec/plan konseyi, judge'lı) → **F**.
  E3b konseyi sabit-üyeli ve implementasyon-odaklıdır.
- **Gerçek architect/senior/router prompt içerikleri** → F/G (E3b config/varsayılan prompt).

---

## 6. Üst Tasarım Doküman Güncellemesi (bu dilimle)

- **Rol tablosu:** `senior-designer` eklenir (13 → **14 role**): "designer N tur takılınca devralır
  (daha güçlü model)".
- **Config örneği:** `"senior-designer": { "models": ["auto/best-coding"], "skills": ["tdd"] }`.
- **§5.4:** merdiven iki simetrik aile (coder/designer) + senior-designer + konsey semantiği
  (architect diagnoz → senior implement → son review → geçer:DONE / insana sor) + `askHuman`
  seam'i.
- **§12 açık noktaları:** "Escalation konseyi çıktısı" ve "N per-tier" kapatılır (E3b'de karara
  bağlandı); task-seviyesi insana-sor (yalnızca konsey tükenince) netleştirilir.

---

## 7. Açık Noktalar / İleride

- `rounds` task-seviyesi ile revision (principal-coder, G) için ayrı config değerleri mi olacak?
  E3b yalnızca task-seviyesi `rounds`'u tüketir; revision'ın kendi turu G'de.
- `askHuman` `retry` sonsuz döngü riski: insan sürücü (abandon ile keser); otomatik üst sınır
  gerekirse E4/H'de eklenebilir.
- Konseyin architect diagnozu salt-okunur; senior implement worktree'yi değiştirir — reviewer
  commit'siz worktree'yi okur (E3a ile aynı; commit E4).
