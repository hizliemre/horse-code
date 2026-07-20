# horse-code Dilim E-skills — Skill Sistemi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-agent'ların skill'lerden yararlanmasını sağlamak — `SkillRegistry` (gömülü + `.horsecode/skills/` yükleme), zorunlu skill'lerin systemPrompt'a enjeksiyonu (`applySkills` + RoleRegistry), ve keşfedilen skill'ler için `skill` tool'u; headless test edilebilir.

**Architecture:** `Skill = {name, description, content}`. `SkillRegistry` skill'leri tutar; `loadFromDir` disk'ten `<dir>/<sub>/SKILL.md` (minimal frontmatter, YAML dep yok) yükler. `applySkills` bir base prompt'a zorunlu skill içeriklerini + keşfedilebilir listing'i ekler; `RoleRegistry` opsiyonel bir `SkillRegistry` alıp `resolve()`'da bunu uygular (geriye uyumlu). `buildSkillTool` keşfedilen skill'i çağıran tool'u verir (çağıran toolset'e ekler). Gerçek skill içerikleri + tool wiring F/G-E3'e ertelenir.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod`, `node:fs/promises`, `vitest`. Yeni bağımlılık YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **Minimal frontmatter** — YALNIZCA `name`/`description` satırları; **YAML bağımlılığı YOK**.
- **Geriye uyumluluk:** `RoleRegistry` `skillRegistry`'siz **aynen mevcut** davranır (mevcut C testleri bozulmaz).
- **Skill = `{ name, description, content }`**; `SkillRegistry.register` aynı adı ezer (son kazanır — kullanıcı gömülüyü override edebilir).
- `loadFromDir`: `SKILL.md`'siz alt-dizin atlanır; frontmatter'da `name`/`description` eksikse → hata; `dir` yoksa → sessiz döner (`.horsecode/skills/` opsiyonel).
- Tüketilen mevcut: `Tool`/`ToolResult` (`src/core/types.js`); `RoleConfig`/`ResolvedConfig`/`fileSchema` (`src/config/config.ts`); `RoleRegistry`/`resolve` (`src/agent/roles.ts`); `zod`.
- Test framework `vitest`; her task TDD (önce başarısız test). fs testleri `mkdtemp` tmp dizinde.

---

### Task 1: Skill + SkillRegistry Çekirdeği

**Files:**
- Create: `src/skills/registry.ts`
- Test: `test/skills/registry.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces:
  - `interface Skill { name: string; description: string; content: string }`
  - `class SkillRegistry` — `register(skill)`, `get(name): Skill|undefined`, `list(): {name,description}[]` (ekleme sırası; aynı ad ezilir).

- [ ] **Step 1: Başarısız testi yaz**

`test/skills/registry.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { SkillRegistry } from "../../src/skills/registry.js";

const skill = (name: string, description = "d", content = "c") => ({ name, description, content });

describe("SkillRegistry çekirdek", () => {
  it("register + get", () => {
    const r = new SkillRegistry();
    r.register(skill("tdd", "TDD akışı", "tdd içerik"));
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD akışı", content: "tdd içerik" });
    expect(r.get("yok")).toBeUndefined();
  });

  it("list ekleme sırasını korur, {name,description} verir", () => {
    const r = new SkillRegistry();
    r.register(skill("a"));
    r.register(skill("b", "bb"));
    expect(r.list()).toEqual([
      { name: "a", description: "d" },
      { name: "b", description: "bb" },
    ]);
  });

  it("aynı adlı skill ezilir (son kazanır)", () => {
    const r = new SkillRegistry();
    r.register(skill("x", "eski"));
    r.register(skill("x", "yeni"));
    expect(r.get("x")!.description).toBe("yeni");
    expect(r.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/skills/registry.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/skills/registry.ts` yaz**

```typescript
export interface Skill {
  name: string;
  description: string;
  content: string;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): { name: string; description: string }[] {
    return [...this.skills.values()].map((s) => ({ name: s.name, description: s.description }));
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/skills/registry.test.ts && npm run typecheck`
Expected: PASS; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/skills/registry.ts test/skills/registry.test.ts
git commit -m "feat: Skill + SkillRegistry çekirdeği (register/get/list)"
```

---

### Task 2: Frontmatter Parser + loadFromDir

**Files:**
- Create: `src/skills/frontmatter.ts`
- Modify: `src/skills/registry.ts` (`loadFromDir` metodu)
- Test: `test/skills/frontmatter.test.ts`, `test/skills/load.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` (`./frontmatter.js`); `node:fs/promises`
- Produces:
  - `parseFrontmatter(raw): { name?: string; description?: string; body: string }` — `---` frontmatter'dan name/description; yoksa `{body:raw}`.
  - `SkillRegistry.loadFromDir(dir): Promise<void>` — `<dir>/<sub>/SKILL.md` tarar; frontmatter+gövde ile register; SKILL.md'siz dizin atlanır; frontmatter eksik → hata; dir yoksa → sessiz.

- [ ] **Step 1: Başarısız testleri yaz**

`test/skills/frontmatter.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("frontmatter'dan name/description + body çıkarır", () => {
    const raw = "---\nname: tdd\ndescription: TDD akışı\n---\ngövde metni\nsatır2";
    expect(parseFrontmatter(raw)).toEqual({ name: "tdd", description: "TDD akışı", body: "gövde metni\nsatır2" });
  });

  it("tırnaklı değerleri kırpar", () => {
    const raw = '---\nname: "x y"\ndescription: \'z\'\n---\nb';
    expect(parseFrontmatter(raw)).toEqual({ name: "x y", description: "z", body: "b" });
  });

  it("frontmatter yoksa body=raw, alanlar undefined", () => {
    expect(parseFrontmatter("sadece metin")).toEqual({ body: "sadece metin" });
  });

  it("eksik alan undefined döner", () => {
    expect(parseFrontmatter("---\nname: x\n---\nb")).toEqual({ name: "x", description: undefined, body: "b" });
  });
});
```

`test/skills/load.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), content, "utf8");
}

describe("SkillRegistry.loadFromDir", () => {
  it("SKILL.md'li dizinleri yükler", async () => {
    await writeSkill("tdd", "---\nname: tdd\ndescription: TDD\n---\ntdd gövde");
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD", content: "tdd gövde" });
  });

  it("SKILL.md'siz dizini atlar", async () => {
    await mkdir(join(dir, "boş"), { recursive: true });
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.list()).toEqual([]);
  });

  it("frontmatter eksikse hata verir", async () => {
    await writeSkill("bad", "frontmatter yok, sadece metin");
    const r = new SkillRegistry();
    await expect(r.loadFromDir(dir)).rejects.toThrow(/frontmatter eksik/);
  });

  it("var olmayan dizinde sessizce döner", async () => {
    const r = new SkillRegistry();
    await expect(r.loadFromDir(join(dir, "yok"))).resolves.toBeUndefined();
    expect(r.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `npx vitest run test/skills/frontmatter.test.ts test/skills/load.test.ts`
Expected: FAIL — modül/metot yok.

- [ ] **Step 3: `src/skills/frontmatter.ts` yaz**

```typescript
/** `---` frontmatter'dan name/description okur; yoksa { body: raw }. YAML dep yok. */
export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const [, fm, body] = m;
  const read = (key: string): string | undefined => {
    const line = fm.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${key}:`));
    if (!line) return undefined;
    let v = line.slice(line.indexOf(":") + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };
  return { name: read("name"), description: read("description"), body };
}
```

- [ ] **Step 4: `src/skills/registry.ts`'e `loadFromDir` ekle**

Dosyanın başına import'ları ekle:
```typescript
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
```

`SkillRegistry` sınıfına (list'ten sonra) ekle:
```typescript
  async loadFromDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir yok → skills opsiyonel, sessiz dön
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let raw: string;
      try {
        raw = await readFile(join(dir, e.name, "SKILL.md"), "utf8");
      } catch {
        continue; // SKILL.md yok → skill dizini değil, atla
      }
      const { name, description, body } = parseFrontmatter(raw);
      if (!name || !description) {
        throw new Error(`skill ${e.name}: frontmatter eksik (name/description)`);
      }
      this.register({ name, description, content: body });
    }
  }
```

- [ ] **Step 5: Testlerin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/skills/frontmatter.test.ts test/skills/load.test.ts && npm run typecheck`
Expected: PASS; hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/skills/frontmatter.ts src/skills/registry.ts test/skills/frontmatter.test.ts test/skills/load.test.ts
git commit -m "feat: frontmatter parser + SkillRegistry.loadFromDir (.horsecode/skills)"
```

---

### Task 3: applySkills + buildSkillTool

**Files:**
- Create: `src/skills/apply.ts`
- Test: `test/skills/apply.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`); `SkillRegistry` (`./registry.js`); `zod`
- Produces:
  - `applySkills(basePrompt: string, mandatory: string[], registry: SkillRegistry): string` — zorunlu skill içeriklerini (`# Zorunlu Skill'ler`) + keşfedilebilir listing'i (`# Keşfedilebilir Skill'ler`) ekler; tanımsız zorunlu skill → hata; ikisi de boşsa basePrompt değişmez.
  - `buildSkillTool(registry: SkillRegistry): Tool` — `name:"skill"`, safe, param `{name}`; bilinen skill → içerik, bilinmeyen → isError.

- [ ] **Step 1: Başarısız testi yaz**

`test/skills/apply.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { applySkills, buildSkillTool } from "../../src/skills/apply.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

function reg(): SkillRegistry {
  const r = new SkillRegistry();
  r.register({ name: "tdd", description: "TDD akışı", content: "önce test yaz" });
  r.register({ name: "cs", description: "kod standartları", content: "temiz kod" });
  return r;
}

describe("applySkills", () => {
  it("zorunlu içerik + keşfedilebilir listing ekler", () => {
    const out = applySkills("BASE", ["tdd"], reg());
    expect(out).toContain("BASE");
    expect(out).toContain("# Zorunlu Skill'ler");
    expect(out).toContain("## tdd");
    expect(out).toContain("önce test yaz");
    expect(out).toContain("# Keşfedilebilir Skill'ler");
    expect(out).toContain("- tdd: TDD akışı");
    expect(out).toContain("- cs: kod standartları");
  });

  it("tanımsız zorunlu skill → hata", () => {
    expect(() => applySkills("BASE", ["yok"], reg())).toThrow(/tanımsız skill/);
  });

  it("boş registry + boş mandatory → basePrompt değişmez", () => {
    expect(applySkills("BASE", [], new SkillRegistry())).toBe("BASE");
  });
});

describe("buildSkillTool", () => {
  it("bilinen skill'in içeriğini döner", async () => {
    const t = buildSkillTool(reg());
    expect(t.name).toBe("skill");
    expect(t.permissionLevel).toBe("safe");
    const res = await t.run({ name: "tdd" }, ctx());
    expect(res).toEqual({ content: "önce test yaz", isError: false });
  });

  it("bilinmeyen skill → isError", async () => {
    const res = await buildSkillTool(reg()).run({ name: "yok" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("bulunamadı");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/skills/apply.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/skills/apply.ts` yaz**

```typescript
import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { SkillRegistry } from "./registry.js";

/** basePrompt'a zorunlu skill içeriklerini ve keşfedilebilir listing'i ekler. */
export function applySkills(basePrompt: string, mandatory: string[], registry: SkillRegistry): string {
  const parts: string[] = [basePrompt];

  if (mandatory.length) {
    const sections = mandatory.map((name) => {
      const skill = registry.get(name);
      if (!skill) throw new Error(`applySkills: tanımsız skill: ${name}`);
      return `## ${skill.name}\n${skill.content}`;
    });
    parts.push(`# Zorunlu Skill'ler\n${sections.join("\n\n")}`);
  }

  const available = registry.list();
  if (available.length) {
    const lines = available.map((s) => `- ${s.name}: ${s.description}`);
    parts.push(`# Keşfedilebilir Skill'ler (skill tool ile içeriğini çağır)\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

const skillParams = z.object({ name: z.string() });

/** Bir skill'in içeriğini adıyla getiren "skill" tool'u (çağıran toolset'e ekler). */
export function buildSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "skill",
    description: "Bir skill'in tam içeriğini adıyla getir.",
    permissionLevel: "safe",
    parameters: skillParams,
    run: async (rawArgs) => {
      const parsed = skillParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `skill: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const skill = registry.get(parsed.data.name);
      if (!skill) return { content: `skill bulunamadı: ${parsed.data.name}`, isError: true };
      return { content: skill.content, isError: false };
    },
  };
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/skills/apply.test.ts && npm run typecheck`
Expected: PASS; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/skills/apply.ts test/skills/apply.test.ts
git commit -m "feat: applySkills (prompt enjeksiyonu) + buildSkillTool (skill tool)"
```

---

### Task 4: Config `RoleConfig.skills`

**Files:**
- Modify: `src/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces: `RoleConfig`'e `skills?: string[]`; `fileSchema.roles` iç objesine `skills` alanı. Katmanlı yükleme aynı (skills role objesiyle taşınır).

- [ ] **Step 1: Başarısız testi yaz (mevcut config testine ekle)**

`test/config/config.test.ts` içindeki `describe("loadConfig", ...)` bloğuna ekle:
```typescript
  it("role skills alanı yüklenir", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ roles: { coder: { models: ["m"], skills: ["tdd", "cs"] } } })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.roles.coder).toEqual({ models: ["m"], skills: ["tdd", "cs"] });
  });
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL — `skills` şemadan düşer (`cfg.roles.coder.skills` undefined).

- [ ] **Step 3: `src/config/config.ts` düzenle**

`RoleConfig` arayüzüne ekle:
```typescript
export interface RoleConfig {
  models: string[];
  systemPrompt?: string;
  skills?: string[];
}
```

`fileSchema`'daki `roles` iç objesine `skills` ekle:
```typescript
    roles: z
      .record(
        z.object({
          models: z.array(z.string()),
          systemPrompt: z.string().optional(),
          skills: z.array(z.string()).optional(),
        }),
      )
      .optional(),
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm testler**

Run: `npx vitest run test/config/config.test.ts && npm test`
Expected: PASS; tüm suite yeşil.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: hata yok.

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: config RoleConfig.skills (zorunlu skill adları)"
```

---

### Task 5: RoleRegistry Skill Entegrasyonu

**Files:**
- Modify: `src/agent/roles.ts`
- Test: `test/agent/roles.test.ts`

**Interfaces:**
- Consumes: `applySkills` (`../skills/apply.js`), `SkillRegistry` (`../skills/registry.js`), `RoleConfig` (`../config/config.js`)
- Produces: `RoleRegistry` kurucusuna opsiyonel 3. param `skillRegistry?: SkillRegistry`; `resolve()` systemPrompt hesaplandıktan sonra, `skillRegistry` varsa `applySkills(systemPrompt, role.skills ?? [], skillRegistry)` uygular. `skillRegistry` yoksa davranış **aynen mevcut**.

- [ ] **Step 1: Başarısız testi yaz (mevcut roles testine ekle)**

`test/agent/roles.test.ts` içine yeni bir describe ekle:
```typescript
import { SkillRegistry } from "../../src/skills/registry.js";

describe("RoleRegistry + skills", () => {
  it("skillRegistry varsa zorunlu skill + listing systemPrompt'a enjekte edilir", () => {
    const skills = new SkillRegistry();
    skills.register({ name: "tdd", description: "TDD akışı", content: "önce test yaz" });
    const reg = new RoleRegistry(
      { coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } },
      {},
      skills,
    );
    const { systemPrompt } = reg.resolve("coder");
    expect(systemPrompt).toContain("BASE");
    expect(systemPrompt).toContain("önce test yaz");
    expect(systemPrompt).toContain("- tdd: TDD akışı");
  });

  it("skillRegistry yoksa systemPrompt değişmez", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } });
    expect(reg.resolve("coder").systemPrompt).toBe("BASE");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/agent/roles.test.ts`
Expected: FAIL — kurucu 3. param'ı desteklemiyor / enjeksiyon yok.

- [ ] **Step 3: `src/agent/roles.ts` düzenle**

Import'lara ekle:
```typescript
import { applySkills } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";
```

Kurucuya 3. param ekle:
```typescript
  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
    private skillRegistry?: SkillRegistry,
  ) {}
```

`resolve()`'da `systemPrompt`'u `const` yerine `let` yap ve return'den ÖNCE enjeksiyonu ekle:
```typescript
    let systemPrompt = role.systemPrompt ?? this.defaultPrompts[roleName];
    if (systemPrompt === undefined) throw new Error(`role '${roleName}' için systemPrompt yok`);

    if (this.skillRegistry) {
      systemPrompt = applySkills(systemPrompt, role.skills ?? [], this.skillRegistry);
    }

    return { model, systemPrompt };
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/agent/roles.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil (mevcut roles/round-robin testleri bozulmaz); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/agent/roles.ts test/agent/roles.test.ts
git commit -m "feat: RoleRegistry skill entegrasyonu (resolve zorunlu skill'leri enjekte eder)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D + E1 + E0 + E-skills)
- [ ] `git log --oneline` — bu dilimde 5 commit

Bu dilim şunu teslim eder: `SkillRegistry` (gömülü + disk yükleme), zorunlu skill'lerin systemPrompt'a enjeksiyonu (RoleRegistry), ve keşfedilen skill'ler için `buildSkillTool`. **E3** (coder/designer/reviewer) `buildSkillTool`'u toolset'e ekleyerek keşfi wire eder; gerçek skill içerikleri **F/G**'de yazılır.

## Kapsam Dışı (bilinçli — sonraki alt-dilimler)

- Gerçek gömülü skill içerikleri (tdd/coding-standards/frontend-design) → F/G.
- `skill` tool'unun runRole/E3'e otomatik wiring'i → E3/F (E-skills primitifi verir).
- Claude Code tarzı skill script/resource'ları; semantic skill arama → ileride.
