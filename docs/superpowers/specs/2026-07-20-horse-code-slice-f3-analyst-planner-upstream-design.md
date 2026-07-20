# horse-code Dilim F3 — Analyst + Planner + Upstream Birleştirme Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.2 akış)
**Üst dilim:** F (upstream). F3 = F'yi tamamlar (analyst/planner + refiner→spec→plan zinciri).

---

## 1. Amaç ve Kapsam

Upstream pipeline'ı uçtan uca bağlar: `refiner` → route → (chat: coach cevabı | pipeline:
**analyst** spec yazar → F2 review döngüsü → **planner** plan yazar → F2 review döngüsü) →
onaylı `{ intent, specPath, planPath }`. Analyst kullanıcıya **`ask_user` tool'uyla** soru sorar.

**Tüketir (tamam):** F1 `runRefiner`/`routeIntent`/`runCoachChat`, `Intent`; F2 `runReviewLoop`,
`ReviewDeps`, `AskUser`; C `runToCompletion`; B2 tool'lar (read/write/edit/grep/glob),
`ToolRegistry`; E-skills `buildSkillTool`; zod.

Konum: `src/engine/upstream.ts` (buildAskUserTool + runAnalyst + runPlanner + runUpstream).

### Kapsam DIŞI (F3 değil)
- **project-manager (board) + team-lead/E4 (dalga) çağrısı** → top-level `runJob` (H). F3 onaylı plan'da biter.
- **Gerçek `askUser` terminal I/O** → H (F3 scripted callback ile test).
- **spec/plan dosyalarının commit'lenmesi (PR'a girmesi)** → runJob/E4. F3 `workdir`'e dosya yazar.
- **Gerçek analyst/planner/refiner/coach prompt içerikleri** → F/G (F3 config/test prompt'uyla).

---

## 2. Bağımlılık Paketi

F3 `ReviewDeps`'i (F2) yeniden kullanır — refiner/coach/analyst/planner/judge rolleri
`roleRegistry`'de, council `councilRegistry`/`councilors`'ta. Ek deps yok.

```typescript
import type { ReviewDeps, AskUser } from "./review.js";
import type { Intent } from "./refiner.js";
```

---

## 3. Birimler (`upstream.ts`)

### 3.1 `buildAskUserTool(askUser: AskUser): Tool`

`buildSkillTool` paterni: `name:"ask_user"`, `permissionLevel:"safe"`,
`parameters: z.object({ question: z.string() })`. `run(args)` → `askUser(question)` → cevabı
tool sonucu (`content`) olarak döner (geçersiz args → `isError`). Analyst yazarken içiçe soru sorar.

### 3.2 `writerRegistry(deps, extra?): ToolRegistry` (yardımcı)

read/write/edit/grep/glob + `buildSkillTool` + `extra[]` (shell/web YOK). Analyst:
`extra=[buildAskUserTool(askUser)]`; planner: `extra` yok.

### 3.3 `runAnalyst(deps, workdir, specPath, prompt, feedback, askUser): Promise<void>`

- `resolve("analyst")` + `writerRegistry(deps, [buildAskUserTool(askUser)])` (cwd=`workdir`).
- Mesaj: `feedback` boşsa → "İstek: `<prompt>`. Gerekirse `ask_user` ile sor; spec'i `<specPath>`'e
  `write_file` ile yaz." Doluysa (revize) → "`<specPath>` spec'ini şu notlarla revize et: `<feedback>`
  (orijinal istek: `<prompt>`)". `runToCompletion` (spec dosyaya yazılır; dönüş `void`).

### 3.4 `runPlanner(deps, workdir, planPath, specPath, feedback): Promise<void>`

- `resolve("planner")` + `writerRegistry(deps)` (ask_user YOK — planner soru sormaz).
- Mesaj: `feedback` boşsa → "`<specPath>` spec'ini oku, plan'ı `<planPath>`'e yaz." Doluysa →
  "`<planPath>` plan'ını şu notlarla revize et: `<feedback>` (`<specPath>` spec'inden)." `runToCompletion`.

### 3.5 `runUpstream(deps, workdir, prompt, askUser, maxRounds): Promise<UpstreamResult>`

```typescript
export type UpstreamResult =
  | { intent: Intent; kind: "chat"; response: string }
  | { intent: Intent; kind: "approved"; specPath: string; planPath: string }
  | { intent: Intent; kind: "rejected"; stage: "spec" | "plan" };
```

```
r = await runRefiner(deps, prompt)
if routeIntent(r.intent) === "chat":
   response = await runCoachChat(deps, r.refinedPrompt, workdir)
   return { intent: r.intent, kind: "chat", response }

specPath = "spec.md"
await runAnalyst(deps, workdir, specPath, r.refinedPrompt, undefined, askUser)   // ilk spec
specOut = await runReviewLoop(deps, workdir, specPath,
             (fb) => runAnalyst(deps, workdir, specPath, r.refinedPrompt, fb, askUser), askUser, maxRounds)
if !specOut.approved: return { intent: r.intent, kind: "rejected", stage: "spec" }

planPath = "plan.md"
await runPlanner(deps, workdir, planPath, specPath, undefined)                    // ilk plan
planOut = await runReviewLoop(deps, workdir, planPath,
             (fb) => runPlanner(deps, workdir, planPath, specPath, fb), askUser, maxRounds)
if !planOut.approved: return { intent: r.intent, kind: "rejected", stage: "plan" }

return { intent: r.intent, kind: "approved", specPath, planPath }
```

- **Abort:** try/catch yok; `runRefiner`/`runAnalyst`/`runReviewLoop`/`runPlanner` throw'u propagate eder.
- `revise` callback'i F2 döngüsüne verilir → judge-sentezlenmiş feedback ile analyst/planner yeniden koşar.

---

## 4. Test Stratejisi

**İçerik-tabanlı deterministik provider** (system prompt'a göre yanıt; paralel council +
sıralı judge counter). Gerçek tmp `workdir`.

- **buildAskUserTool:** `tool.run({question:"X?"})` → `askUser("X?")` çağrılır, cevabı `content`'te döner.
- **runAnalyst:** provider analyst'i `write_file("spec.md", ...)` çağırıp bitirir → `workdir/spec.md`
  yazıldı; toolset `ask_user`+`write_file` İÇERİR, `shell` İÇERMEZ. `feedback` doluysa istekte notlar geçer.
  ask_user senaryosu: analyst `ask_user("X?")` → sonra `write_file` → `askUser` çağrıldı.
- **runPlanner:** spec dosyası varken planner `write_file("plan.md")` → `workdir/plan.md` yazıldı;
  toolset `write_file` var, `ask_user` YOK.
- **runUpstream:**
  - chat: refiner `intent:"chat"` → `runCoachChat` → `{kind:"chat", response}`.
  - approved: refiner `"feature"` → analyst spec yazar → council(approve)+judge `pass` → planner
    plan yazar → council+judge `pass` → `{kind:"approved", specPath:"spec.md", planPath:"plan.md"}`;
    `workdir`'de iki dosya var.
  - rejected(spec): judge hep `revise`, maxRounds küçük, son `askUser`→"durdur" → `{kind:"rejected", stage:"spec"}`.
  - abort: pre-aborted → fırlatır.

Tümü `vitest`, TDD, içerik-tabanlı provider + gerçek fs (tmp workdir) + scripted `askUser`.

---

## 5. F3 DIŞI (bilinçli ertelenen)

- **runJob (F → E2 board → E4 dalga) top-level orkestrasyonu** → H.
- **spec/plan commit'i + session yaşam döngüsü** → runJob/E4/H.
- **Gerçek terminal `askUser`** → H.
- **Gerçek role prompt içerikleri** → F/G.

---

## 6. Açık Noktalar / İleride

- spec/plan dosya adları F3'te sabit (`spec.md`/`plan.md`, workdir köküne); runJob bunları
  session docs yoluna taşıyıp commit edebilir (ileride).
- `maxRounds` spec ve plan için tek param; ayrı değerler gerekirse ileride ayrıştırılır.
- Analyst `ask_user`'ı çağırmayabilir (agent kararı); belirsizlikler council/judge revize
  döngüsünde de yakalanır — ikisi tamamlayıcı.
- `writerRegistry` shell/web dışlar (analyst/planner dosya yazar, komut çalıştırmaz); ileride
  bir role'ün shell'e ihtiyacı olursa genişletilir.
