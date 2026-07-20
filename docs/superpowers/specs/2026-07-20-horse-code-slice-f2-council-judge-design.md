# horse-code Dilim F2 — Council + Judge Review Döngüsü Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§6 council + judge)
**Üst dilim:** F (upstream). F2 = yeniden kullanılabilir review döngüsü (spec + plan aynı döngüden geçer).

---

## 1. Amaç ve Kapsam

§6 review mekanizması: bir **doküman** (spec veya plan dosyası) config'lenebilir **councilor'lar**
tarafından **paralel**, çok-mercekli değerlendirilir → **judge** sentezleyip tek karar verir
(**pass / revize / insana-sor**) → döngü. Generic: `revise(feedback)` callback'i dokümanı yeniden
üretir (analyst/planner F3'te sağlar); `askUser` seam'i insan sorularını taşır.

**Tüketir (tamam):** E0 `runStructuredRole`; E3a `readOnlyRegistry`, `TaskCycleDeps`; E-skills
`RoleRegistry` (round-robin); Foundation `loadConfig`/`ResolvedConfig`; zod.

Konum: `src/config/config.ts` (councilor tipi); `src/engine/review.ts` (council/judge/loop —
`council.ts` escalation konseyidir, çakışmasın diye ayrı dosya).

### Kapsam DIŞI (F2 değil)
- **analyst (spec) / planner (plan) üretimi** → F3 (`revise` callback'ini F3 verir).
- **`runUpstream` zinciri** → F3.
- **Gerçek `askUser` terminal I/O** → H (F2 scripted callback ile test).
- **Gerçek councilor/judge prompt içerikleri** → F/G (F2 varsayılan template).

---

## 2. Config Uzantısı — councilor'lar

```typescript
export interface CouncilorConfig { name: string; perspective: string; models: string[] }
// ResolvedConfig kazanır:
council?: { councilors: CouncilorConfig[] };
```

`fileSchema`'ya eklenir (opsiyonel):
```
council: z.object({ councilors: z.array(z.object({
  name: z.string(), perspective: z.string(), models: z.array(z.string()),
})) }).optional()
```
Katmanlama: proje config'i council'ı ezebilir (roles gibi shallow); `DEFAULT_CONFIG.council`
tanımsız (yok).

---

## 3. Bağımlılık Paketi + Tipler

```typescript
export interface ReviewDeps extends TaskCycleDeps {  // provider, roleRegistry(judge içerir), skillRegistry, permission, approve, signal
  councilRegistry: RoleRegistry;      // buildCouncilRegistry(config.council.councilors) — round-robin
  councilors: CouncilorConfig[];      // isim listesi (iterasyon)
}
export type AskUser = (question: string) => Promise<string>;

export interface Assessment { name: string; concerns: string[]; recommendation: "approve" | "revise" }
export const AssessmentSchema = z.object({
  concerns: z.array(z.string()),
  recommendation: z.enum(["approve", "revise"]),
});

export interface JudgeDecision { decision: "pass" | "revise" | "ask-human"; feedback: string[]; question: string }
export const JudgeSchema = z.object({
  decision: z.enum(["pass", "revise", "ask-human"]),
  feedback: z.array(z.string()),
  question: z.string(),   // ask-human dışında "" olabilir
});

export interface ReviewOutcome { approved: boolean }
```

---

## 4. Birimler (`review.ts`)

### 4.1 `buildCouncilRegistry(councilors): RoleRegistry`

Her councilor'ı bir role'e eşler: `name → { models: councilor.models, systemPrompt:
councilPrompt(perspective) }`. `RoleRegistry`'nin round-robin'i modelleri döndürür (spec-review
sonra plan-review çağrılarında rotasyon). `councilPrompt(p)` varsayılan template: "Sen bir review
council üyesisin. Perspektifin: <p>. Dokümanı bu perspektiften incele; concerns + öneri üret."
(skillRegistry verilmez → skill listing yok; councilor skill kullanmaz.)

### 4.2 `runCouncil(deps: ReviewDeps, workdir, docPath): Promise<Assessment[]>`

- `deps.councilors`'ı **paralel** koşar (`Promise.all`). Her councilor:
  `deps.councilRegistry.resolve(c.name)` (round-robin model + perspektif prompt) + salt-okunur
  toolset (`readOnlyRegistry(deps)`, cwd=`workdir`) + mesaj: "`<docPath>` dokümanını incele" →
  `runStructuredRole(opts, AssessmentSchema)` → `{name: c.name, ...result}`.
- Councilor dokümanı `read_file` ile okur. Abort/hata `Promise.all`'dan propagate eder.

### 4.3 `runJudge(deps: ReviewDeps, workdir, docPath, assessments): Promise<JudgeDecision>`

- `deps.roleRegistry.resolve("judge")` + salt-okunur toolset (cwd=`workdir`) + mesaj:
  `<docPath>` + councilor değerlendirmelerinin özeti (`assessments`) → `runStructuredRole(opts,
  JudgeSchema)`. Judge dokümanı okuyup değerlendirmeleri sentezler → tek karar.

### 4.4 `runReviewLoop(deps, workdir, docPath, revise, askUser, maxRounds): Promise<ReviewOutcome>`

```
for round in 1..maxRounds:
   assessments = await runCouncil(deps, workdir, docPath)
   d = await runJudge(deps, workdir, docPath, assessments)
   if d.decision === "pass": return { approved: true }
   feedback = d.feedback
   if d.decision === "ask-human":
      answer = await askUser(d.question)
      feedback = [...feedback, `İnsan cevabı: ${answer}`]
   await revise(feedback)                 // producer (analyst/planner) dokümanı yeniden üretir
// maxRounds tükendi → son karar insana (onayla/durdur)
answer = await askUser(`${maxRounds} revize turunda onaylanmadı. Onayla / durdur?`)
return { approved: /onayla|approve|evet|yes/i.test(answer) }
```

- `revise: (feedback: string[]) => Promise<void>` — dokümanı `docPath`'te yeniden üretir (F3 wiring).
- `askUser: (q: string) => Promise<string>` — insan cevabı (H'de terminal). Hem judge `ask-human`
  hem maxRounds-son-kararı bu seam'i kullanır.
- **Abort:** döngüde try/catch yok; `runCouncil`/`runJudge`/`revise`/`askUser` throw'u propagate eder.

---

## 5. Test Stratejisi

Paralel councilor'lar için **içerik-tabanlı provider** (systemPrompt'taki perspektif/rol'e göre
yanıt — `MockProvider` global index'i paralelde nondeterministik). Gerçek tmp `workdir` + doküman dosyası.

- **config:** `council.councilors` JSON'dan parse → `ResolvedConfig.council.councilors`; yok → `undefined`.
- **buildCouncilRegistry:** 2 councilor → `resolve(name)` round-robin model döndürür; systemPrompt perspektifi içerir.
- **runCouncil (paralel):** 2 councilor (güvenlik/mimari), içerik-provider her perspektife assessment
  → `[{name:"security",...}, {name:"arch",...}]`; her councilor toolset'i salt-okunur (write yok).
- **runJudge:** assessments + judge prompt → `{decision:"pass",...}` / `{decision:"revise", feedback}`
  / `{decision:"ask-human", question}`.
- **runReviewLoop:**
  - pass ilk turda → `{approved:true}`, `revise` çağrılmadı.
  - revise → judge revize → `revise(feedback)` çağrıldı (feedback içerir) → ikinci tur pass → approved.
  - ask-human → `askUser` çağrıldı, cevap sonraki `revise` feedback'inde → pass → approved.
  - maxRounds tükendi (hep revise) → son `askUser` "onayla" → `{approved:true}`; "durdur" → `{approved:false}`.
  - abort: pre-aborted → fırlatır.

Tümü `vitest`, TDD, içerik-tabanlı provider + gerçek fs (tmp workdir) + scripted `revise`/`askUser`.

---

## 6. F2 DIŞI (bilinçli ertelenen)

- **analyst/planner** (doküman üretimi + `revise` implementasyonu) → F3.
- **`runUpstream`** (refiner → spec-loop → plan-loop) → F3.
- **Gerçek terminal `askUser`** → H.
- **Councilor skill'leri / gerçek prompt içerikleri** → F/G.

---

## 7. Açık Noktalar / İleride

- `maxRounds` config değeri mi (ör. `council.maxRounds`) yoksa param mı — F2 param alır; F3/config
  wiring sonra. Escalation `rounds`'tan ayrı (review vs task-escalation farklı).
- Councilor `Promise.all` — biri fırlatırsa tümü reddeder (motor durur); ileride per-councilor
  tolerans (bir merceğin hatası diğerlerini düşürmesin) gerekebilir.
- maxRounds-son-kararı `askUser` metnini regex'le yorumlar (onayla/durdur) — H yapılandırılmış
  soru sunar; ileride yapılandırılmış bir human-decision seam'i düşünülebilir.
- `readOnlyRegistry` reviewer.ts'ten paylaşılıyor (F1 notu) — F2 de kullanır; nötr `tool-sets.ts`'e
  çıkarma bu dilimde yapılabilir (opsiyonel).
