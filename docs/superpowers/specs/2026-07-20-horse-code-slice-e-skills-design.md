# horse-code Dilim E-skills — Skill Sistemi Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§4.4 Skills)

---

## 1. Amaç ve Kapsam

Role-agent'ların **skill**'lerden yararlanmasını sağlamak: her role'e **zorunlu skill'ler**
atanabilir (içerikleri system prompt'a enjekte edilir) ve role, registry'de **keşfedilen**
skill'leri bir `skill` tool'uyla çağırabilir. E3 (coder/designer/reviewer), F/G role'leri bunu
tüketir.

**Skill = `{ name, description, content }`** (markdown talimat). Kaynak: pakette **gömülü** (TS
sabiti; mekanizma ile gelir, gerçek içerikler F/G'de) + kullanıcı `.horsecode/skills/<name>/SKILL.md`.

**Tüketir (tamam):** `Tool`/`ToolResult` (`src/core/types.js`); `RoleConfig`/`ResolvedConfig`
(`src/config/config.js`); `RoleRegistry` (`src/agent/roles.js`); `zod`; `node:fs/promises`.

---

## 2. Birimler

```
src/skills/frontmatter.ts  → parseFrontmatter(raw)
src/skills/registry.ts     → Skill, SkillRegistry (register/get/list/loadFromDir)
src/skills/apply.ts        → applySkills(basePrompt, mandatory, registry) + buildSkillTool(registry)
src/config/config.ts       → RoleConfig'e skills?: string[]
src/agent/roles.ts         → RoleRegistry'ye skillRegistry (resolve enjekte eder)
```

---

## 3. Arayüzler

### 3.1 Skill & SkillRegistry (`src/skills/registry.ts`)

```typescript
export interface Skill { name: string; description: string; content: string }

export class SkillRegistry {
  register(skill: Skill): void;               // aynı adlı skill'i ezer (son kazanır)
  get(name: string): Skill | undefined;
  list(): { name: string; description: string }[];   // ekleme sırası
  loadFromDir(dir: string): Promise<void>;    // <dir>/<sub>/SKILL.md tarar, register eder
}
```

- **`loadFromDir(dir)`**: `dir` altındaki her alt-dizinde `SKILL.md` arar; varsa `parseFrontmatter`
  ile `name`+`description`+`content` (gövde) çıkarır ve `register` eder. `SKILL.md` **yoksa** o
  alt-dizin **atlanır** (skill dizini değil). `SKILL.md` var ama frontmatter'da `name`/`description`
  **eksikse** → net hata (`skill <sub>: frontmatter eksik (name/description)`). Skill adı
  frontmatter `name`'idir (dizin adı değil). `dir` yoksa → hata (veya boş? → sessiz döner, çünkü
  `.horsecode/skills/` opsiyonel).

### 3.2 Frontmatter parser (`src/skills/frontmatter.ts`)

```typescript
export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string };
```

- `raw` `---\n` ile başlıyorsa: kapanış `---` bulunur; aradaki `key: value` satırlarından `name` ve
  `description` okunur (değerin baş/son tırnağı ve boşluğu kırpılır); `body` = kapanıştan sonrası.
- Frontmatter yoksa: `{ body: raw }` (name/description undefined). **YAML bağımlılığı YOK** — yalnızca
  `name`/`description` satırları ayrıştırılır.

### 3.3 applySkills + buildSkillTool (`src/skills/apply.ts`)

```typescript
export function applySkills(basePrompt: string, mandatory: string[], registry: SkillRegistry): string;
export function buildSkillTool(registry: SkillRegistry): Tool;
```

- **`applySkills`**: `basePrompt`'a şunları ekleyerek büyütülmüş prompt döner:
  - Her **zorunlu** skill adı için `registry.get(name)`; **yoksa → hata** (`applySkills: tanımsız
    skill: <name>`). İçerikleri "## <name>\n<content>" bölümleri olarak **`# Zorunlu Skill'ler`**
    başlığı altında.
  - `registry.list()` boş değilse **`# Keşfedilebilir Skill'ler (skill tool ile içeriğini çağır)`**
    başlığı altında `- <name>: <description>` listesi.
  - Ne zorunlu ne keşfedilebilir varsa → `basePrompt` değişmeden döner.
- **`buildSkillTool`**: `name:"skill"`, `permissionLevel:"safe"`, `parameters: z.object({ name:
  z.string() })`, `run(args)` → `registry.get(name)` varsa `{ content: skill.content, isError:false }`,
  yoksa `{ content: "skill bulunamadı: <name>", isError:true }`. **Çağıran (E3/F) bu tool'u role'ün
  toolset'ine ekler** (keşfedilen skill'lerin çalışması için).

### 3.4 Config + RoleRegistry entegrasyonu

- **`RoleConfig`** (`config.ts`) → `skills?: string[]` eklenir (zorunlu skill adları). `fileSchema`
  ve katmanlı yükleme aynı (skills alanı da role objesiyle taşınır).
- **`RoleRegistry`** (`roles.ts`) → kurucu opsiyonel 3. param `skillRegistry?: SkillRegistry`.
  `resolve()` systemPrompt'u hesapladıktan SONRA, `skillRegistry` varsa
  `systemPrompt = applySkills(systemPrompt, role.skills ?? [], skillRegistry)` uygular. `skillRegistry`
  yoksa davranış **aynen mevcut** (geriye uyumlu).

---

## 4. Veri Akışı

```
config: roles.coder.skills = ["tdd", "coding-standards"]
SkillRegistry: gömülü + .horsecode/skills/ (loadFromDir)
   │
RoleRegistry(roles, defaultPrompts, skillRegistry).resolve("coder")
   → systemPrompt = applySkills(baseCoderPrompt, ["tdd","coding-standards"], skillRegistry)
       = baseCoderPrompt + "# Zorunlu Skill'ler\n## tdd\n<tdd içerik>..." + "# Keşfedilebilir Skill'ler\n- ..."
   │
E3/F: role-agent'ı çalıştırırken toolset'e buildSkillTool(skillRegistry) eklenir
   → rol listeden bir skill görüp `skill(name)` çağırınca içeriği tool-result olarak alır
```

---

## 5. Test Stratejisi

- **parseFrontmatter (saf):** frontmatter'lı (name/description + gövde, tırnaklı değerler); frontmatter'sız (body=raw); eksik alan (undefined döner).
- **SkillRegistry:** register/get/list (sıra); `loadFromDir` (tmp fs): `<dir>/tdd/SKILL.md` → yüklendi; `SKILL.md`'siz dizin atlanır; frontmatter eksik → hata.
- **applySkills (saf):** zorunlu içerik enjekte; keşfedilebilir listing; tanımsız zorunlu skill → hata; boş → basePrompt değişmez.
- **buildSkillTool:** bilinen skill → içerik; bilinmeyen → isError.
- **config:** `roles.<name>.skills` katmanlı yüklenir.
- **RoleRegistry:** skillRegistry ile resolve → systemPrompt zorunlu içerik + listing içerir; skillRegistry'siz → değişmez.
- Tümü `vitest`, TDD. fs testleri `mkdtemp` tmp dizinde.

---

## 6. E-skills DIŞI (bilinçli ertelenen)

- **Gerçek gömülü skill içerikleri** (tdd/coding-standards/frontend-design) → F/G (role prompt'larıyla birlikte). E-skills mekanizmayı kurar; içerikler yer-tutucu olabilir.
- **`skill` tool'unun runRole/E3'e otomatik wiring'i** → E3/F. E-skills `buildSkillTool`'u verir; çağıran toolset'e ekler.
- **Claude Code tarzı skill script/resource'ları** (SKILL.md dışı dosyalar) → ileride. MVP: ad+açıklama+markdown.
- **Skill keşif/arama (semantic)** → MVP: düz `{name, description}` listesi.

---

## 7. Açık Noktalar / İleride

- `loadFromDir` `dir` yoksa: sessiz döner (`.horsecode/skills/` opsiyonel) — plan bunu doğrular.
- Zorunlu skill içeriklerinin prompt'a enjeksiyonu prompt'u büyütür; token bütçesi ileride (compaction MVP dışı) izlenebilir.
- Skill adı çakışması (gömülü vs kullanıcı): son register kazanır; kullanıcı skill'i gömülüyü ezebilir (kasıtlı override).
