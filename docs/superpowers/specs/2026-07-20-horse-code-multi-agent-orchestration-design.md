# horse-code — Çok-Ajanlı Orkestrasyon Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, dilimlenmeye hazır
**Paket:** `horse-code` (npm) · **CLI:** `hcode`

---

## 1. Amaç ve Kapsam

Bu doküman, horse-code'un **kodlama mekanizmasını** tanımlar: tek modelli standart bir
tool-calling agent yerine, her biri omniroute üzerinde tanımlı LLM modelleriyle çalışan
**çok-ajanlı, role-tabanlı, board-güdümlü bir orkestrasyon.** İş; refine → spec → council/judge
→ plan → council/judge → kanban board → izole worktree'lerde paralel kodlama → PR → PR-review
zinciriyle akar. İkinci bir **revision** pipeline'ı PR yorumlarını kapatır.

### Bu spec'in önceki spec'le ilişkisi

`2026-07-19-horse-code-coding-agent-design.md`'deki **§3 (tek tool-calling agent loop)** ve
**"MVP'de YOK: sub-agent'lar, git worktree"** kararı bu tasarımla **bilinçli olarak
geçersiz kılınır.** Asıl ürün bu orkestrasyondur. Ancak o spec'in alt katmanları
(Provider soyutlaması, Tool arayüzü, katmanlı config, permission motoru, omniroute sözleşmesi)
**aynen geçerlidir ve temeldir** — bu tasarım onların üstüne oturur. Foundation dilimi
(tipler + config + permission) tamamlanmıştır.

---

## 2. Roller

Sistem **14 adlandırılmış role + bir councilor havuzundan** oluşur. Her role omniroute'ta
tanımlı **bir veya birden fazla** modele bağlanır (bkz. §4 round-robin) ve **zorunlu skill'ler**
atanabilir (bkz. §4.4 Skills).

| Role | Sorumluluk |
|------|-----------|
| **refiner** | Her prompt'u refine eder; `intent` etiketi üretir (`chat` / `feature` / `bugfix`) |
| **coach** | Kullanıcı cephesi. Chat cevaplar; iş başında session ana worktree'sini açar; iş sonunda final raporu sunar |
| **analyst** | Kullanıcıya sorular sorarak **spec** dosyasını yazar |
| **planner** | Spec'teki kararlara göre **plan** dosyasını yazar |
| **council** (`councilors[]`) | Spec ve planı çok-mercekli review eder. Her councilor: `{ name, perspective, models }` |
| **judge** | Council değerlendirmelerini sentezleyip tek karar verir: **geçer / revize / insana sor** |
| **project-manager** | Planı gerçek task'lara böler, session board'unu yaratır |
| **team-lead** | Bağımlılık grafiği + dalgaları çıkarır, dispatch eder |
| **coder** | Task'ı kendi izole worktree'sinde uygular |
| **designer** | **UI/UX task'larını** uygular (coder-benzeri uygulayıcı; board UI/UX işlerini coder yerine buna yönlendirir) |
| **code-reviewer** | REVIEW'daki task'ı inceler (karar **nihai**) |
| **senior-coder** | coder N tur takılınca devralır (daha güçlü model); revision'da ana worktree'de çalışır |
| **senior-designer** | designer N tur takılınca devralır (daha güçlü model) |
| **architect** | Task-escalation konseyi üyesi |
| **principal-coder** | PR'ı review eder (1 tur); revision döngüsünün nihai karar mercii |

---

## 3. Mimari Katmanlama

Kilit içgörü: önceki spec'teki "agent loop" kaybolmaz, **iç döngü** olur. İki katman:

### 3.1 İç döngü — role-agent

`(model, systemPrompt, toolset, workdir)` ile bağlanmış **tek bir tool-calling LLM döngüsü.**
Her role bu primitifin bir örneğidir:

- **coder** = `read/grep/glob/write/edit/shell` tool'lu, task worktree'sinde koşan bir agent loop
- **analyst** = `read/grep` + `ask-user` tool'lu, spec üreten bir loop
- **code-reviewer** = `read/grep` tool'lu, verdikt üreten bir loop

İç döngü Provider (omniroute) üzerinden LLM'e konuşur; tool çağrılarını permission motoruyla
süzer. Bu, orijinal spec'in §3 loop'unun genelleştirilmiş, model/prompt/tool ile
parametrelenmiş halidir.

### 3.2 Dış orkestrasyon — engine

Role grafiğine göre iç döngüleri **kompoze eder.** Deterministik bir motordur; sahiplendiği
şeyler:

- board state'i ve kart geçişleri (tek doğruluk kaynağı — SoT)
- bağımlılık dalgaları ve paralel yürütme
- worktree yaşam döngüsü (aç / türet / merge)
- escalation merdivenleri
- role başına model round-robin index'i
- human-in-the-loop askıya alma/devam

Role-ajanları **karar** verir (assign, pass/fail, verdikt); ama **kartı motor taşır.** Bu
ayrım sistemi headless test edilebilir kılar ve kaçak agent döngüsü riskini ortadan kaldırır.

---

## 4. Config & Model Round-Robin

### 4.1 Config şekli

Foundation'daki katmanlı config'e (yerleşik → global → proje → env) role tanımları eklenir:

```jsonc
{
  "baseUrl": "http://localhost:20128",   // omniroute local-first
  "mode": "ask",
  "allowlist": [],
  "roles": {
    "refiner":       { "models": ["aug/claude-haiku-4.5"], "systemPrompt": "..." },
    "coach":         { "models": ["cc/claude-opus-4-8"] },
    "analyst":       { "models": ["cc/claude-opus-4-8"] },
    "planner":       { "models": ["cc/claude-opus-4-8"] },
    "judge":         { "models": ["cc/claude-opus-4-8"] },
    "project-manager": { "models": ["cc/claude-sonnet-5"] },
    "team-lead":     { "models": ["cc/claude-sonnet-5"] },
    "coder":         { "models": ["cc/claude-sonnet-5", "cc/claude-opus-4-8"], "skills": ["tdd", "coding-standards"] },
    "designer":      { "models": ["cc/claude-opus-4-8"], "skills": ["frontend-design"] },
    "code-reviewer": { "models": ["cc/claude-opus-4-8"] },
    "senior-coder":  { "models": ["auto/best-coding"], "skills": ["tdd"] },
    "senior-designer": { "models": ["auto/best-coding"], "skills": ["tdd"] },
    "architect":     { "models": ["auto/best-reasoning"] },
    "principal-coder": { "models": ["cc/claude-opus-4-8"] }
  },
  "council": {
    "councilors": [
      { "name": "security",    "perspective": "güvenlik açıkları, secret sızıntısı", "models": ["cc/claude-opus-4-8"] },
      { "name": "architecture","perspective": "katman ihlali, bağımlılık yönü",      "models": ["cc/claude-opus-4-8"] },
      { "name": "testability", "perspective": "test edilebilirlik, izolasyon",        "models": ["cc/claude-sonnet-5"] }
    ]
  }
}
```

### 4.2 Round-robin

Bir role birden fazla modele bağlanabilir. Engine, o role için **her ajan spawn'ında** model
listesinde round-robin yapar: `models[index++ % models.length]`, role başına ayrı dönen index.
Seçilen tek model id'si omniroute'a gönderilir.

**İş bölümü:** *"çalışan provider'ı bul / upstream failover"* zaten omniroute'un işidir
(`auto/*`, `502 All upstream providers failed`) — tekrarlanmaz. *"Kendi seçtiğim modeller
arasında role başına rotasyon"* engine'in işidir; omniroute'ta kullanıcı-tanımlı havuz
primitifi yoktur ve bu politika horse-code'un role semantiğine özgüdür. Provider ince bir
transport olarak kalır; model seçim politikası engine'dedir. Bir role'ün listesine
`auto/best-coding` gibi omniroute-tarafı seçim isteyen elemanlar da konabilir.

### 4.3 System prompt'lar

Her role'ün bir system prompt'u vardır. Pakette **gömülü varsayılanlar** bulunur; config'ten
role başına override edilebilir (dosya yolu veya inline string). Tüm akış için bu prompt'ların
yazılması ayrı bir iştir (dilim E–G kapsamında).

### 4.4 Skills

Her role, çalışırken **skill**'lerden yararlanır. Skill = adlandırılmış bir talimat/yetkinlik
birimi: `{ name, description, content }` (markdown talimat). MVP'de ad+açıklama+markdown; ileride
Claude Code tarzı dizin (SKILL.md + script/resource) olarak genişleyebilir.

**Kaynak (SkillRegistry ikisini de yükler):**
- Pakette **gömülü varsayılan skill'ler** (horse-code ile gelir).
- Kullanıcı tanımlı **`.horsecode/skills/<name>/SKILL.md`**.

**İki kullanım biçimi:**
- **Zorunlu (atanmış) skill'ler** — role config `roles.<name>.skills: string[]`. Bu skill'lerin
  **içeriği role'ün system prompt'una enjekte edilir** (her zaman aktif). Örn. `coder → ["tdd",
  "coding-standards"]`, `designer → ["frontend-design"]`. "Bizim tanımladığımız skill'ler."
- **Keşfedilen skill'ler** — role-agent'a bir **`skill` tool**'u verilir (adıyla skill çağır →
  içeriği tool-result olarak döner) ve registry'nin **`{name, description}` listesi** role'ün
  prompt'una konur ki neyin mevcut olduğunu bilsin. Ne zaman çağıracağına **rol kendisi** karar
  verir. "Rolün kendi keşfetmesi."

**Katmanlama:** Zorunlu skill çözümü RoleRegistry'de (resolve → mandatory skill içeriklerini
systemPrompt'a önekle); `skill` tool + listing role-agent'ın toolset'inde. `SkillRegistry` ayrı
bir birim (gömülü + kullanıcı skill'lerini yükler, `get(name)`/`list()` verir). Bu, role-agent'ların
çalışması için bir **ön-koşul alt-dilim**dir (bkz. §11 roadmap: **E-skills**).

---

## 5. Pipeline 1 — bugfix/feature

### 5.1 Giriş & intent routing

```
kullanıcı prompt
   → refiner  → { refinedPrompt, intent: "chat" | "feature" | "bugfix" }
   → engine deterministik route:
        intent == "chat"            → coach cevaplar (pipeline başlamaz)
        intent ∈ {feature, bugfix}  → bugfix/feature pipeline başlar
```

refiner her prompt'un ilk durağıdır (ucuz model). Refine + sınıflandırma tek çağrıda; route
engine tarafından deterministik yapılır.

### 5.2 Akış

```
coach → session ana worktree'sini aç (seçilen branch'ten, temiz)
  │
analyst → [spec dosyası]  ──► council → judge   (§6 review döngüsü)
  │
planner → [plan dosyası]  ──► council → judge   (§6 review döngüsü)
  │
project-manager → planı task'lara böl, BOARD yarat (TODO/IN-PROGRESS/REVIEW/DONE)
  │
team-lead → bağımlılık grafiği + dalgalar
  │
  ├─ Dalga N: bağımsız task'lar paralel
  │     her task: coder (izole worktree) → REVIEW → code-reviewer
  │        ├─ geçer → DONE
  │        └─ reddeder → task'a notlar, TODO'ya düş (§5.4 escalation)
  │     dalga tüm task'ları DONE → worktree'ler ana worktree'ye MERGE
  │     sonraki dalga → güncellenmiş base'den türer
  │
  └─ tüm dalgalar DONE → PR aç (GitHub/Azure MCP) → principal-coder review (§7)
```

### 5.3 Worktree & dalga merge

İki katmanlı worktree hiyerarşisi:

```
seçilen branch
   └─► SESSION ANA WORKTREE (coach açar, temiz)
          ├─► task worktree wt_a  ┐
          ├─► task worktree wt_b  ├─ dalga sonu → ana worktree'ye merge
          └─► task worktree wt_c  ┘
```

Her coder işini ana worktree'den **türetilmiş ayrı worktree'de** yapar → paralel coder'lar
birbirinin dosyalarını ezmez. Dalga bitince o dalganın worktree'leri ana worktree'ye merge
edilir; **sonraki dalganın worktree'leri güncellenmiş base'den türer** (böylece `t4`, `t2`'nin
işini görür). Tüm dalgalar bittiğinde ana worktree PR'a açılır.

### 5.4 Task-seviyesi escalation merdiveni

code-reviewer'ın kararı **nihaidir**; reddedilen task doğrudan TODO'ya düşer (judge yoktur).
Takılan task için merdiven:

```
coder    ──(N tur)──► senior-coder     ──(N tur)──►┐
designer ──(N tur)──► senior-designer  ──(N tur)──►┴► ESCALATION KONSEYİ
   { architect (kök-neden + plan) + senior (implement) + code-reviewer (son review) }
   → geçer: DONE (bağlayıcı) / kalır: insana sor (accept / retry / abandon)
```

İki simetrik aile (coder/senior-coder ve designer/senior-designer) kendi N-turluk merdivenlerini
tüketince aynı escalation konseyinde birleşir. Konsey `askHuman` seam'iyle insana çıkar
(task-seviyesinde insan-in-loop yalnızca konsey tükendiğinde devreye girer; normal review'da
code-reviewer nihai). `N` = tier başına tur (config `escalation.rounds`, varsayılan 3).

### 5.5 coder — yeni vs dönen task ayrımı

coder bir task'ı alınca bunun **yeni** mi yoksa reviewer'dan **dönen** bir task mı olduğunu
ayırt etmelidir. Ayrım karttaki `reviewNotes[]` alanından türer: notlar varsa → dönen task
(notları gider), yoksa → yeni task. coder'ın system prompt'u bu ayrıma göre dallanır.

---

## 6. Council + Judge Review Döngüsü

Spec ve plan aynı döngüden geçer:

```
[spec | plan] → council: her councilor kendi perspektifinden gerekçeli değerlendirme üretir
                (kendi modeliyle, paralel)
   │
   ▼
judge → değerlendirmeleri sentezler, tek karar verir:
   ├─ "geçer"      → pipeline ilerler
   ├─ "revize"     → gerekçelerle analyst'e (spec) / planner'a (plan) geri gönder → tekrar council → judge
   └─ "insana sor" → soru terminal'e düşer; cevap alınınca → analyst / planner'a döner
```

Council'da sabit bir oy eşiği yoktur — **judge** ilerleme/geri-gönderme/insana-sorma kararının
tek sahibidir ve döngüyü yönetir. Bu, task-seviyesi review'dan farklıdır (orada code-reviewer
nihai, judge yok).

---

## 7. PR Review & Revision Pipeline'a Geçiş

Tüm task'lar DONE olup PR açıldığında:

```
principal-coder → PR'ı review eder (TEK TUR)
   ├─ onaylar → iş biter, coach final raporu sunar (§9)
   └─ değişiklik ister → bulgular PR'a comment olarak işlenir (GitHub/Azure MCP)
                          → REVISION pipeline başlar (§8)
```

---

## 8. Pipeline 2 — revision

principal-coder'ın PR yorumlarıyla tetiklenir:

```
principal-coder → board'a REVISION task açar
   │
team-lead → işi senior-coder'a verir
   │
senior-coder → ⚠ YENİ worktree AÇMAZ; ana worktree üzerinde çalışır
   ├─ thread'leri kapatır: fix eder veya "by design" olarak kapatır
   └─ bitince REVISION task → DONE
   │
DONE olunca → aynı pipeline tekrar koşar: principal-coder re-review
   │  (bir DÖNGÜ; ≤ 3 tur)
   └─ 3. turda hâlâ bulgu varsa → principal-coder SON KARAR
        ├─ kabul → biter
        └─ netlik yoksa → "insana sor" (soru terminal'e düşer, cevap alınır)
```

bugfix/feature'dan farkı: coder'lar izole worktree açar; revision'da senior-coder mevcut PR'ın
ana worktree'sinde doğrudan çalışır (thread'leri kapatıyor).

Not: **principal developer = principal-coder** (isim gevşekliği; aynı role).

---

## 9. Board, Task Veri Modeli & Audit Trail

Board **proje geneli değildir** — her session **kendi board'unu** yaratır ve sadece o iş için
kullanılır. Kalıcılık: `.horsecode/sessions/<id>/board.json` (mevcut jsonl session kaydının
yanında).

Kolonlar: `TODO · IN-PROGRESS · REVIEW · DONE`.

Kart şeması:

```typescript
interface Card {
  id: string;
  title: string;
  column: "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE";
  worktree?: string;          // task'ın izole worktree yolu (revision'da ana worktree)
  deps: string[];             // bağımlı olduğu kart id'leri (team-lead dalgaları buradan çıkarır)
  reviewNotes: string[];      // reviewer/principal-coder notları; coder yeni-vs-dönen ayrımını buradan yapar
  attempts: number;           // escalation merdiveni sayacı
  stageHistory: StageEvent[]; // audit trail
}

interface StageEvent {
  role: string;               // coder | code-reviewer | senior-coder | ...
  action: string;             // assigned | implemented | reviewed:pass | reviewed:fail | escalated | ...
  note?: string;
}
```

**stageHistory** kritik: bir task'ın hangi aşamalardan geçtiğinin tam kaydıdır. İş bitince
**coach final raporu bu geçmişlerden türetir** — "hangi task'ta ne oldu" bilgisini tasklardan
çıkarır. İleride board için bir UI yazılacaktır (MVP dışı).

---

## 10. Human-in-the-Loop

İki yerden insana soru düşebilir:

- **judge** (council döngüsünde): "insana sor" → analyst/planner'a dönmeden önce
- **principal-coder** (revision döngüsünde, 3. turdan sonra): "insana sor"

Mekanizma: soru **session içinde terminal'e** düşer, akış askıya alınır; kullanıcı cevap
verince akış **kaldığı yere döner** (judge → analyst/planner; principal-coder → revision kararı).

---

## 11. Uygulama Dilimleri (Roadmap)

Bu tasarım tek bir implementation plan'a sığmaz; sırayla dilimlenir. Foundation
(tipler + config + permission) tamamlandı. Sonraki dilimler:

| Dilim | İçerik | Bağımlılık | Durum |
|-------|--------|-----------|-------|
| **B — Provider + Tools** | omniroute client + `read/grep/glob/write/edit/shell/web` | Foundation | ✅ |
| **C — Role-agent iç döngüsü** | role registry + round-robin + system-prompt yükleme + tool-calling loop | B | ✅ |
| **D — Worktree manager** | ana worktree aç, task worktree türet, dalga merge, PR aç (MCP) | C | ✅ |
| **E0 — Structured role output** | role-agent loop'a şema-doğrulamalı çıktı (C uzantısı) | C | |
| **E-skills — SkillRegistry** | gömülü + `.horsecode/skills/` yükleme; zorunlu skill → systemPrompt enjeksiyonu; keşif için `skill` tool + listing | C | |
| **E1 — Board (SoT)** | Card/kolon/mutasyon/audit + `board.json` kalıcılığı | — | ✅ |
| **E2 — project-manager + team-lead** | plan→kart, deps→dalgalar (structured output'la) | E0, E1 | |
| **E3 — Task yürütme + escalation** | coder/**designer**/code-reviewer + coder→senior-coder→konsey; yeni-vs-dönen | E0, E-skills, E1, C, D | |
| **E4 — Dalga motoru + entegrasyon** ★ | deterministik dış döngü: dalgalar → paralel task → dalga-merge → conflict-council → PR | E1, E2, E3, D | |
| **F — Upstream pipeline** | refiner-routing + coach + analyst + planner + council + judge | C, E0 | |
| **G — Revision pipeline** | principal-coder + PR-review + revision döngüsü + MCP comment | D, E4 | |
| **H — TUI / CLI** | Ink UI, terminal soru-cevap (human-in-loop), final rapor render | tümü | |

★ = kullanıcının önceliği (asıl kodlama mekanizması). E, alt-dilimlere bölündü (E0/E-skills/
E1/E2/E3/E4); build sırası bottom-up. **designer** rolü E3'te uygulayıcı olarak devreye girer
(board UI/UX task'larını coder yerine designer'a yönlendirir — routing E2/team-lead'de); role
system prompt içerikleri (designer dahil) F/G'de yazılır. **Skill** mekanizması (§4.4) E-skills'te
kurulur; role-agent'lar (E3, F, G) zorunlu + keşfedilen skill'leri buradan tüketir.

---

## 12. Açık Noktalar / İleride Kararlaştırılacaklar

- **`N` (escalation tur sayısı):** varsayılan öneri 3; config'lenebilir. Task-seviyesi
  (coder→senior-coder) ve revision (principal-coder) için ayrı ayrı mı, tek değer mi?
  **Kararlaştırıldı (E3b):** tier başına `N` (config `escalation.rounds`, vars. 3); config
  okuma E4'te wire edilir.
- **Escalation konseyi çıktısı:** **Kararlaştırıldı (E3b):** architect diagnoz + senior
  implement + son review; geçer→DONE, kalır→insana sor (accept/retry/abandon).
- **MCP sağlayıcı seçimi (GitHub vs Azure):** PR/comment için hangi MCP'nin kullanılacağı
  repo/remote'tan mı tespit edilecek, config'ten mi? (Dilim G.)
- **System prompt içerikleri:** her role için gömülü varsayılan prompt metinleri (Dilim E–G).
- **coach'un chat modunda tool erişimi:** salt-okunur repo tool'ları mı, hiç tool yok mu?
  (Dilim F.)
