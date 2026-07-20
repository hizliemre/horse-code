# horse-code Dilim F1 — Refiner + Intent Routing + Coach Chat Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.1 giriş & intent)
**Üst dilim:** F (upstream pipeline). F1 = giriş noktası (refiner + route + coach chat).

---

## 1. Amaç ve Kapsam

Upstream pipeline'ın **girişi**: her kullanıcı prompt'u `refiner` ile refine edilip `intent`
etiketlenir (`chat`/`feature`/`bugfix`); engine **deterministik** route eder — `chat` → coach
cevaplar (pipeline başlamaz), `feature`/`bugfix` → pipeline (F2/F3). Coach chat modu **salt-okunur
repo tool'larıyla** cevap verir.

**Tüketir (tamam):** E0 `runStructuredRole`; C `runToCompletion`; E-skills `RoleRegistry`
(skill enjeksiyonlu), `buildSkillTool`; E3a `readOnlyRegistry` (read/grep/glob + skill),
`TaskCycleDeps`; B2 `ToolRegistry`; zod.

Konum: `src/engine/refiner.ts` (refiner + route), `src/engine/coach.ts` (coach chat).

### Kapsam DIŞI (F1 değil)
- **analyst/planner/council/judge** → F2/F3.
- **Konuşma döngüsü (çok-turlu chat) + gerçek terminal I/O** → H. F1 tek prompt → tek cevap.
- **Session açma (coach worktree açar)** → E4c `openSession` / top-level `runJob`.
- **Gerçek refiner/coach prompt içerikleri** → F/G (F1 config/test prompt'uyla).

---

## 2. Bağımlılık Paketi

F1 mevcut `TaskCycleDeps`'i yeniden kullanır (ek alan yok):

```typescript
// { provider, roleRegistry, skillRegistry, permission, approve, signal }
import type { TaskCycleDeps } from "./task-types.js";
```

Config'te `refiner` ve `coach` rolleri tanımlı olmalı (generic `RoleConfig`; F1 config şeması
değiştirmez).

---

## 3. Birimler

### 3.1 `runRefiner(deps, prompt): Promise<RefinerOutput>` (refiner.ts)

```typescript
export type Intent = "chat" | "feature" | "bugfix";
export interface RefinerOutput { refinedPrompt: string; intent: Intent }
export const RefinerSchema = z.object({
  refinedPrompt: z.string(),
  intent: z.enum(["chat", "feature", "bugfix"]),
});
```

- `resolve("refiner")` → `{model, systemPrompt}` (skill'ler enjekte).
- Toolset: `new ToolRegistry()` + `buildSkillTool(deps.skillRegistry)` (E-skills coupling — repo
  tool'u YOK; refiner yalnız refine + sınıflandırır).
- `runStructuredRole(opts, RefinerSchema)` → `{ refinedPrompt, intent }`. Mesaj: kullanıcı prompt'u.
  `cwd: "."` (fs tool'u yok, önemsiz). Ucuz model (config).

### 3.2 `routeIntent(intent): "chat" | "pipeline"` (refiner.ts)

Saf, deterministik fonksiyon:
```
routeIntent(intent) = intent === "chat" ? "chat" : "pipeline"
```
`feature` ve `bugfix` aynı upstream pipeline'a gider; `intent` değeri ileride (F3) analyst/planner
çerçevelemesine taşınır.

### 3.3 `runCoachChat(deps, prompt, cwd): Promise<string>` (coach.ts)

- `resolve("coach")` → `{model, systemPrompt}` (skill'ler enjekte).
- Toolset: `readOnlyRegistry(deps)` (read/grep/glob + skill — write/edit/shell YOK). Coach repo'yu
  okuyup cevaplayabilir.
- `runToCompletion(opts)` → son `message.done`'ın `.content`'i döner (tool-call'suz final tur =
  coach'un metin cevabı). Mesaj: `prompt` (F3'te `refinedPrompt`). `cwd` = repo kökü (read tool'ları için).

---

## 4. Test Stratejisi

`MockProvider` (scripted turn'ler) + gerçek `RoleRegistry`/`SkillRegistry`. Ağsız.

- **runRefiner:** submit `{refinedPrompt:"...", intent:"feature"}` → `{intent:"feature", refinedPrompt}`.
  Populated `SkillRegistry` → istek tool'ları `skill` içerir (E-skills coupling). Pre-aborted signal → fırlatır.
- **routeIntent:** `"chat"→"chat"`, `"feature"→"pipeline"`, `"bugfix"→"pipeline"` (birim test).
- **runCoachChat:** (a) tek-tur `[text "cevabım", done stop]` → `"cevabım"`; (b) `read_file` tool
  turn → sonra text turn → final metni döner + istek tool'ları `read_file`/`grep`/`glob`/`skill`
  İÇERİR, `write_file`/`shell` İÇERMEZ (salt-okunur doğrula). Pre-aborted → fırlatır.

Tümü `vitest`, TDD, `MockProvider`.

---

## 5. F1 DIŞI (bilinçli ertelenen)

- **analyst (spec) + planner (plan) + council + judge review döngüsü** → F2/F3.
- **`runUpstream` (refiner → chat|pipeline zinciri)** → F3 (F1 birimleri sağlar, zincir F3'te).
- **Çok-turlu konuşma + terminal I/O** → H.
- **Session/worktree + E2/E4 wiring** → E4c / top-level `runJob` (H).

---

## 6. Açık Noktalar / İleride

- refiner tek çağrıda refine + sınıflandırır; belirsiz intent'te varsayılan davranış (schema
  `enum` zorlar; geçersizse `runStructuredRole` retry/throw) — F/G'de prompt netleştirir.
- coach chat tek-tur; F3/H çok-turlu konuşma sarmalayabilir (geçmiş `messages`'e eklenir).
- `intent` değerinin (feature vs bugfix) pipeline'da nasıl farklılaştığı (prompt çerçevelemesi)
  F3'te netleşir; F1 yalnız `chat` vs `pipeline` route eder.
