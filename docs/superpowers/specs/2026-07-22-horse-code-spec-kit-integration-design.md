# horse-code'a Yerleşik spec-kit Entegrasyonu — Tasarım

**Tarih:** 2026-07-22
**Durum:** Onaylandı (implementasyon planı bekliyor)

## Amaç

horse-code'un geliştirme-öncesi spec geliştirme akışını, GitHub'ın [spec-kit](https://github.com/github/spec-kit) Spec-Driven Development metodolojisi + template'leriyle yerleşik hale getirmek. Kullanıcı, AI ile **yapılandırılmış soru-cevap** şeklinde ilerleyen bir spec olgunlaştırma deneyimi yaşamalı; çıktılar spec-kit formatında ve taşınabilir olmalı; template içeriği spec-kit güncellemeleriyle **senkron** kalmalı.

## Mimari (özet)

spec-kit temelde bir metodoloji + **markdown template'ler** + komut-prompt'ları + hafif scaffolding script'leridir; "zeka" template'lerde, çalıştıran ajan horse-code'un kendisidir. Bu yüzden entegrasyon = spec-kit'in template içeriğini **çalışma anında pinli bir sürümden çekip** horse-code'un rolleriyle sürmek. Harici Python/uvx yok.

horse-code'un mevcut hattı `refiner → analyst(spec) → review → planner(plan) → review → PM(tasks) → waves(implement)` zaten spec-kit fazlarına paraleldir. Bu entegrasyon `analyst/planner/PM`'in yerini spec-kit template'leriyle sürülen fazlara bırakır; `refiner`, review loop ve `waves` korunur.

## Kararlar (onaylandı)

1. **Template kaynağı:** spec-kit template'leri pinli bir git tag'inden (`raw.githubusercontent.com/github/spec-kit/<tag>/templates/…`) çekilir, `~/.horsecode/spec-kit/<tag>/` altında cache'lenir. Python yok; ilk çekimden sonra çevrimdışı çalışır. Config'de `specKit.version` ile pinlenir. **Varsayılan pin: `v0.13.2`** (bu tasarım anındaki en güncel kararlı sürüm).
2. **Kapsam:** `constitution → specify → clarify → plan → tasks` (implement mevcut waves'te kalır).
3. **Akış kontrolü:** Hibrit — feature/bugfix niyetinde hat otomatik sürer (clarify'da duraklar) + her faz slash komutu olarak da erişilebilir.
4. **Scaffolding (numaralama/dizin):** spec-kit'in bash script'leri çalıştırılmaz; bu ufak mantık horse-code'da TS ile yeniden yazılır. Değerli kısım (prompt/template içeriği) yine spec-kit'ten senkron gelir.
5. **Artifact düzeni:** spec-kit'in düzeni benimsenir: `.specify/memory/constitution.md` + `specs/<NNN-slug>/{spec,plan,tasks}.md` (worktree içinde). Mevcut `.hc/spec.md`, `.hc/plan.md`'nin yerini alır.
6. **Kalite kapısı:** horse-code'un mevcut council/judge review loop'u korunur; spec-kit `/analyze` bu tasarımın kapsamı dışında (sonra eklenebilir).

## Bileşenler

### 1. Template fetcher — `src/speckit/templates.ts`

**Sorumluluk:** Pinli sürümdeki spec-kit template'lerini indirip cache'lemek ve okumak.

- Çekilecek dosyalar (pinli `<tag>` altında `templates/`):
  - `spec-template.md`, `plan-template.md`, `tasks-template.md`, `constitution-template.md`, `checklist-template.md`
  - `commands/` altındaki komut-prompt'ları: `constitution.md`, `specify.md`, `clarify.md`, `plan.md`, `tasks.md` (dosya adları `speckit.` önekli DEĞİL)
- Kaynak URL deseni: `https://raw.githubusercontent.com/github/spec-kit/<tag>/templates/<path>`
- Cache: `~/.horsecode/spec-kit/<tag>/templates/…`. Dosya cache'te varsa ağ çağrısı yapılmaz.
- Arayüz:
  ```ts
  export interface SpecKitTemplates {
    version: string;
    template(name: "spec" | "plan" | "tasks" | "constitution" | "checklist"): string;
    command(name: "constitution" | "specify" | "clarify" | "plan" | "tasks"): string;
  }
  export async function loadSpecKit(opts: {
    version: string; home: string; fetch?: FetchLike;
  }): Promise<SpecKitTemplates>;
  ```
- **Hata yönetimi:** Ağ hatası + cache yoksa → net hata: "spec-kit templates (<tag>) indirilemedi; ağ bağlantısını kontrol et veya specKit.version'ı geçerli bir tag'e ayarla." Cache varsa ağ hatası sessizce cache'e düşer.
- Config alanı (`ResolvedConfig`): `specKit?: { version: string }`. Varsayılan sabit bir tag (ör. spec-kit'in bilinen kararlı bir sürümü).

### 2. Artifact düzeni + scaffolding — `src/speckit/layout.ts`

**Sorumluluk:** spec-kit dizin yapısını worktree içinde kurmak ve feature numaralama/slug üretmek (spec-kit bash script'lerinin TS karşılığı).

- `specDir(workdir)` → `<workdir>/specs`
- `constitutionPath(workdir)` → `<workdir>/.specify/memory/constitution.md`
- `nextFeatureSlug(workdir, title): string` → `specs/` altında en yüksek `NNN` + 1 ile `NNN-<title-slug>` üretir (title = refiner'ın İngilizce title'ı; `toSlug` ile ≤5 kelime). Örn. `001-add-login-page`.
- `featurePaths(workdir, slug)` → `{ spec, plan, tasks }` mutlak yolları (`specs/<slug>/spec.md` vb.).
- Dizinleri oluşturur (`mkdir -p` eşleniği).

### 3. Fazlar — mevcut roller + spec-kit prompt'ları

Her faz, ilgili spec-kit **komut-prompt'unu** sistem/görev bağlamı olarak alır, ilgili **template'i** dolduracak şekilde çalışır ve çıktıyı doğru artifact yoluna yazar. Roller mevcut `runStructuredRole`/writer-registry desenini kullanır.

- **constitution** (`src/speckit/phases.ts` → `runConstitution`)
  - Proje başına bir kez. `constitutionPath` yoksa çalışır (auto akışta) veya `/constitution` ile zorlanır.
  - `commands/constitution.md` prompt'u + `constitution-template.md` → `.specify/memory/constitution.md` yazar. Gerekirse `ask_user` ile ilkeleri sorar.
- **specify** → `runSpecify` — `commands/specify.md` + `spec-template.md` → `specs/<slug>/spec.md`. (Mevcut `runAnalyst`'in yerini alır.)
- **clarify** → `runClarify` (aşağıda ayrı bölüm).
- **plan** → `runPlan` — `commands/plan.md` + `plan-template.md` + constitution + spec → `plan.md`. (Mevcut `runPlanner`'ın yerini alır.)
- **tasks** → `runTasks` — `commands/tasks.md` + `tasks-template.md` + plan → `tasks.md`. (Mevcut PM task üretiminin yerini alır; `waves` bu `tasks.md`'yi okur.)

### 4. Clarify Q&A — `src/speckit/clarify.ts` (çekirdek özellik)

**Sorumluluk:** spec.md'deki belirsiz/eksik alanları yapılandırılmış, tek tek soruyla kapatmak.

- `commands/clarify.md` prompt'u kullanılır; spec.md okunur.
- Model, öncelik sırasına göre **en fazla 5** hedefli soru üretir. Her soru **tek tek** `ask_user` ile sorulur → mevcut `? Question` pending UI ile render edilir.
- Her cevaptan sonra model spec.md'nin ilgili bölümünü günceller (write/edit) → soru-cevap ilerledikçe spec olgunlaşır.
- Yeterince açıklık olduğunda veya 5 soru dolduğunda faz biter.
- **Yapı (structured):** clarify, `{ questions: [{ id, question, targetSection }], done }` gibi bir şema yerine, pragmatik olarak: döngüde model "sıradaki soru veya BİTTİ" döndürür (`submit` ile `{ nextQuestion?: string, updatedSpec: boolean }`), controller soruyu kullanıcıya sorar, cevabı bağlama ekler, tekrar çağırır. Üst sınır 5 tur.

### 5. Slash komutları

Mevcut slash-palette registry'sine (`src/tui/commands.ts`) eklenir:

| Komut | Aksiyon |
|---|---|
| `/constitution` | constitution fazını (yeniden) çalıştır |
| `/specify` | mevcut feature için specify fazını çalıştır |
| `/clarify` | mevcut spec üzerinde clarify Q&A |
| `/plan` | plan fazını çalıştır |
| `/tasks` | tasks fazını çalıştır |

Komutlar, o an açık bir feature bağlamı (aktif `specs/<slug>/`) gerektirir; yoksa kullanıcıya feature başlatması söylenir. Auto akış zaten bir feature bağlamı kurar.

### 6. Pipeline entegrasyonu — `src/engine/upstream.ts`

Mevcut feature/bugfix dalı yeniden yazılır:

```
feature/bugfix niyeti →
  ensureWorktree(title) →
  constitution yoksa runConstitution →
  slug = nextFeatureSlug(workdir, title) →
  runSpecify → review loop →
  runClarify (Q&A) →
  runPlan → review loop →
  runTasks →
  { specPath, planPath, tasksPath } → waves
```

- `runReviewLoop` (council/judge) spec ve plan sonrası korunur.
- `waves`/implement `tasks.md`'yi okuyacak şekilde uyarlanır (mevcut PM board üretimi `tasks.md` parse'ına köprülenir).

## Veri akışı

1. Kullanıcı feature prompt'u girer → refiner niyet + title üretir.
2. Worktree açılır (`title` ile anlamlı ad).
3. spec-kit templates cache'ten yüklenir (yoksa pinli tag'den çekilir).
4. constitution yoksa interaktif kurulur.
5. specify → spec.md; review loop.
6. clarify → tek tek Q&A, spec.md güncellenir.
7. plan → plan.md; review loop. tasks → tasks.md.
8. waves → tasks.md'den kod.

## Hata yönetimi

- **Template indirilemiyor + cache yok:** net, aksiyon-alınabilir hata; pipeline durur.
- **Bozuk/eksik template dosyası:** hangi dosya + tag raporlanır.
- **clarify üst sınırı:** 5 turda kapanmazsa mevcut spec'le devam edilir (sonsuz Q&A yok).
- **constitution reddi:** kullanıcı constitution'ı boş geçerse minimal bir varsayılan yazılır, akış devam eder.

## Test stratejisi

- `templates.ts`: sahte `fetch` ile indirme + cache davranışı (cache hit ağ çağrısı yapmaz; ağ hatası + cache → cache; ağ hatası + cache yok → throw).
- `layout.ts`: `nextFeatureSlug` numaralama (boş `specs/`, mevcut `001-…` varken `002-…`), path üretimi.
- `phases.ts` / `clarify.ts`: `MockProvider` ile — specify spec.md yazar; clarify tek tek soru sorar (≤5), her cevap sonrası spec güncellenir, done'da biter.
- `upstream.ts`: entegre akış — constitution yoksa kurulur, artifact'lar doğru yollara yazılır, review loop çağrılır.
- `commands.ts` / TUI: yeni slash komutları palette'te listelenir ve doğru faza yönlenir.

## Kapsam dışı (bu tasarım)

- spec-kit `/analyze` (cross-artifact tutarlılık) ve `/converge`.
- spec-kit'in per-agent `.claude/commands/` scaffold'u (horse-code kendi rollerini kullanır).
- spec-kit bash/powershell script'lerinin çalıştırılması (TS'te yeniden yazılır).
- Template pack zip/release-asset ayrıştırma (raw dosya çekimi yeterli).

## Dosya yapısı (yeni/değişen)

- **Yeni:** `src/speckit/templates.ts`, `src/speckit/layout.ts`, `src/speckit/phases.ts`, `src/speckit/clarify.ts`
- **Değişen:** `src/engine/upstream.ts` (pipeline), `src/config/config.ts` (`specKit.version`), `src/tui/commands.ts` (slash komutları), `src/prompts.ts` (constitution/clarify rol prompt'ları gerekiyorsa), `waves`/implement (`tasks.md` okuma)
- **Artifact (kullanıcı repo'sunda, worktree):** `.specify/memory/constitution.md`, `specs/<NNN-slug>/{spec,plan,tasks}.md`
