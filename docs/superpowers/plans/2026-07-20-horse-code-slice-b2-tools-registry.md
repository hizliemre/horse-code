# horse-code Dilim B2 — Tools + Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-agent'ların kod tabanı üzerinde çalışması için 7 tool'u (`read_file`, `write_file`, `edit_file`, `grep`, `glob`, `shell`, `web_fetch`) ve bunları LLM'e sunan `ToolRegistry`'yi inşa etmek — her tool `Tool` sözleşmesini uygular, `PermissionEngine` ile entegre onay için `describe()` üretir, gerçek FS/child_process ile ama tmp dizinde tam test edilebilir.

**Architecture:** Foundation'daki `Tool` arayüzü (`src/core/types.ts`) bir `describe?()` ile genişletilir (write/exec tool'ları onay `allowKey` + `preview` üretir; safe tool'larda gerekmez). Her tool kendi dosyasında (`src/tools/<ad>.ts`), tek sorumluluk. `ToolRegistry` tool'ları tutar ve `schemas()` ile zod parametrelerini JSON Schema'ya çevirip provider'ın beklediği biçimde verir. FS tool'ları gerçek dosya sistemiyle çalışır (testler `mkdtemp` ile geçici dizinde); `web_fetch` enjekte edilebilir `fetch` alır (ağsız test).

**Tech Stack:** TypeScript (ESM), Node ≥ 20 (`node:fs/promises`, `node:child_process`, `node:path`, `node:os`, yerleşik `fetch`), `zod`, `picomatch` (mevcut), `zod-to-json-schema` (YENİ), `vitest`.

## Global Constraints

- Node ≥ 20 (yerleşik `fetch`/`AbortController`; `node:*` çekirdek modülleri — polyfill yok).
- TypeScript ESM (`"type": "module"`), `strict: true`, `moduleResolution: "bundler"`; relative import'lar `.js` uzantılı.
- Her tool `Tool` sözleşmesini (`src/core/types.ts`) uygular: `{ name, description, permissionLevel, parameters (zod), run(args, ctx) }` + opsiyonel `describe(args)`.
- `permissionLevel`: `read_file`/`grep`/`glob`/`web_fetch` → `safe`; `write_file`/`edit_file` → `write`; `shell` → `exec` (spec §4).
- Tool'lar path'leri `ctx.cwd`'ye göre çözer (`resolve(ctx.cwd, path)`); `describe().allowKey` ise kullanıcının/allowlist'in ifade ettiği **göreli path'i** (veya komutu) taşır — allowlist kuralları `src/**` gibi göreli globlarla eşleşir.
- Hata dayanıklılığı: tool `run` **asla throw etmez**; başarısızlıkta `{ content: "<mesaj>", isError: true }` döner (loop'u çökertmesin — Foundation kararı).
- Sandboxing YOK (MVP dışı): path jail'i, gitignore parse'ı yok. `walk` sabit bir skip listesi kullanır (`node_modules`, `.git`, `dist`, `.horsecode`).
- İptal: `run` `ctx.signal`'i onurlandırır (`shell` süreci öldürür, `web_fetch` isteği iptal eder).
- Tüketilen mevcut tipler (`src/core/types.ts`): `Tool`, `ToolResult`, `ToolContext`, `PermissionLevel`, `ChatRequest`. Bu dilim `Tool`'a `describe?` ve yeni `PermissionDescriptor` ekler (geriye uyumlu — opsiyonel).
- Test framework `vitest`; her task TDD (önce başarısız test). FS testleri `mkdtemp(tmpdir())` ile izole geçici dizinde koşar, `afterEach`'te silinir.

---

### Task 1: Tool Sözleşmesini Genişlet + ToolRegistry

**Files:**
- Modify: `src/core/types.ts` (`PermissionDescriptor` + `Tool.describe?` eklenir)
- Modify: `package.json` (`zod-to-json-schema` bağımlılığı)
- Create: `src/tools/registry.ts`
- Test: `test/tools/registry.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ChatRequest` (`src/core/types.js`)
- Produces:
  - `interface PermissionDescriptor { allowKey: string; preview: string }` (`types.ts`)
  - `Tool.describe?(args: Record<string, unknown>): PermissionDescriptor` (opsiyonel)
  - `class ToolRegistry` — `register(t: Tool): void`, `get(name: string): Tool | undefined`, `list(): Tool[]`, `schemas(): ChatRequest["tools"]` (her tool'un zod `parameters`'ını JSON Schema'ya çevirir).

- [ ] **Step 1: Bağımlılığı kur**

Run: `npm install zod-to-json-schema@^3.23.5`
Expected: `package.json` dependencies'e eklenir, hata yok.

- [ ] **Step 2: `src/core/types.ts`'e tip eklemelerini yap**

`Tool` arayüzünün ÜSTÜNE ekle:
```typescript
export interface PermissionDescriptor {
  allowKey: string; // shell: komut · dosya: hedef yol
  preview: string; // kullanıcıya gösterilecek özet (komut, diff başlığı, vb.)
}
```

`Tool` arayüzüne `run`'dan sonra opsiyonel metodu ekle:
```typescript
export interface Tool {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;
  parameters: z.ZodType;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  // write/exec tool'ları onay isteği üretir; safe tool'larda gerekmez.
  describe?(args: Record<string, unknown>): PermissionDescriptor;
}
```

- [ ] **Step 3: Başarısız testi yaz**

`test/tools/registry.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/core/types.js";

const fakeTool: Tool = {
  name: "read_file",
  description: "dosya okur",
  permissionLevel: "safe",
  parameters: z.object({ path: z.string() }),
  run: async () => ({ content: "ok", isError: false }),
};

describe("ToolRegistry", () => {
  it("register + get + list çalışır", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    expect(reg.get("read_file")).toBe(fakeTool);
    expect(reg.get("yok")).toBeUndefined();
    expect(reg.list()).toEqual([fakeTool]);
  });

  it("schemas() zod parametreleri JSON Schema'ya çevirir", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("read_file");
    expect(schemas[0].description).toBe("dosya okur");
    expect(schemas[0].parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });
});
```

- [ ] **Step 4: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/registry.js'`.

- [ ] **Step 5: `src/tools/registry.ts` yaz**

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatRequest, Tool } from "../core/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** LLM'e gönderilecek tool şemaları: zod parameters → JSON Schema. */
  schemas(): ChatRequest["tools"] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters, { target: "openApi3" }),
    }));
  }
}
```

- [ ] **Step 6: Testin geçtiğini doğrula + tüm testler (types testi bozulmadı)**

Run: `npx vitest run test/tools/registry.test.ts && npm run typecheck`
Expected: PASS; typecheck hatasız (mevcut `test/core/types.test.ts` `describe` eklenmesinden etkilenmez — opsiyonel).

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/tools/registry.ts test/tools/registry.test.ts package.json package-lock.json
git commit -m "feat: Tool.describe sözleşmesi + ToolRegistry (zod→JSON Schema)"
```

---

### Task 2: read_file (safe)

**Files:**
- Create: `src/tools/read.ts`
- Test: `test/tools/read.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`)
- Produces: `export const readFileTool: Tool` — `name:"read_file"`, `safe`, `parameters: { path: string }`. `run` cwd'ye göreli dosyayı okur; yoksa `isError:true`.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/read.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../../src/tools/read.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("var olan dosyanın içeriğini döner", async () => {
    await writeFile(join(dir, "a.txt"), "merhaba", "utf8");
    const res = await readFileTool.run({ path: "a.txt" }, ctx());
    expect(res).toEqual({ content: "merhaba", isError: false });
  });

  it("olmayan dosyada isError:true döner (throw etmez)", async () => {
    const res = await readFileTool.run({ path: "yok.txt" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("read_file");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/read.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/read.ts` yaz**

```typescript
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ path: z.string() });

export const readFileTool: Tool = {
  name: "read_file",
  description: "Bir dosyanın içeriğini okur (cwd'ye göreli veya mutlak yol).",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const args = params.parse(rawArgs);
    try {
      const content = await readFile(resolve(ctx.cwd, args.path), "utf8");
      return { content, isError: false };
    } catch (e) {
      return {
        content: `read_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/read.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts test/tools/read.test.ts
git commit -m "feat: read_file tool"
```

---

### Task 3: write_file (write)

**Files:**
- Create: `src/tools/write.ts`
- Test: `test/tools/write.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`)
- Produces: `export const writeFileTool: Tool` — `name:"write_file"`, `write`, `parameters: { path: string; content: string }`. `describe` → `{ allowKey: path, preview: "write <path> (<n> bytes)" }`. `run` üst dizinleri oluşturur, dosyayı yazar.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/write.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../../src/tools/write.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-write-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("write_file", () => {
  it("üst dizinleri oluşturarak dosya yazar", async () => {
    const res = await writeFileTool.run({ path: "src/yeni.ts", content: "export const x = 1;" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "src/yeni.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("describe onay için allowKey + preview üretir", () => {
    const d = writeFileTool.describe!({ path: "src/a.ts", content: "abc" });
    expect(d.allowKey).toBe("src/a.ts");
    expect(d.preview).toContain("src/a.ts");
    expect(d.preview).toContain("3"); // byte sayısı
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/write.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/write.ts` yaz**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ path: z.string(), content: z.string() });

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Bir dosyaya içerik yazar (üzerine yazar, üst dizinleri oluşturur).",
  permissionLevel: "write",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.path, preview: `write ${a.path} (${Buffer.byteLength(a.content)} bytes)` };
  },
  async run(rawArgs, ctx) {
    const a = params.parse(rawArgs);
    const target = resolve(ctx.cwd, a.path);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, a.content, "utf8");
      return { content: `Yazıldı: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `write_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/write.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/write.ts test/tools/write.test.ts
git commit -m "feat: write_file tool (describe ile onay)"
```

---

### Task 4: edit_file (write)

**Files:**
- Create: `src/tools/edit.ts`
- Test: `test/tools/edit.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`)
- Produces: `export const editFileTool: Tool` — `name:"edit_file"`, `write`, `parameters: { path, oldString, newString, replaceAll? }`. `describe` → `{ allowKey: path, preview: "edit <path>" }`. `run`: `oldString` 0 kez → hata; >1 kez ve `!replaceAll` → hata; aksi halde değiştirip yazar.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/edit.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool } from "../../src/tools/edit.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-edit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("benzersiz eşleşmeyi değiştirir", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "b", newString: "Y" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("a Y a");
  });

  it("çoklu eşleşmede replaceAll olmadan hata döner", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "a", newString: "X" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("benzersiz");
  });

  it("replaceAll ile tüm eşleşmeleri değiştirir", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run(
      { path: "f.txt", oldString: "a", newString: "X", replaceAll: true },
      ctx(),
    );
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("X b X");
  });

  it("eşleşme yoksa hata döner", async () => {
    await writeFile(join(dir, "f.txt"), "abc", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "zzz", newString: "Y" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("bulunamadı");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/edit.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/edit.ts` yaz**

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Bir dosyada birebir string değişimi yapar. oldString benzersiz olmalı (yoksa replaceAll gerekir).",
  permissionLevel: "write",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.path, preview: `edit ${a.path}` };
  },
  async run(rawArgs, ctx) {
    const a = params.parse(rawArgs);
    const target = resolve(ctx.cwd, a.path);
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (e) {
      return {
        content: `edit_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const count = content.split(a.oldString).length - 1;
    if (count === 0) {
      return { content: `edit_file: oldString bulunamadı (${a.path})`, isError: true };
    }
    if (count > 1 && !a.replaceAll) {
      return {
        content: `edit_file: oldString benzersiz değil (${count} eşleşme) — replaceAll gerekli`,
        isError: true,
      };
    }
    const next = a.replaceAll
      ? content.split(a.oldString).join(a.newString)
      : content.replace(a.oldString, a.newString);
    try {
      await writeFile(target, next, "utf8");
      return { content: `Düzenlendi: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `edit_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/edit.test.ts`
Expected: PASS (4 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/edit.ts test/tools/edit.test.ts
git commit -m "feat: edit_file tool (benzersizlik guard + replaceAll)"
```

---

### Task 5: walkFiles Yardımcısı

**Files:**
- Create: `src/tools/walk.ts`
- Test: `test/tools/walk.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces: `walkFiles(root: string): AsyncIterable<string>` — `root` altındaki tüm dosyaların **mutlak** yollarını yield eder; `node_modules`/`.git`/`dist`/`.horsecode` dizinlerini atlar; okunamayan dizinde sessizce durur. `grep` ve `glob` bunu tüketir.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/walk.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkFiles } from "../../src/tools/walk.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-walk-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("walkFiles", () => {
  it("dosyaları döner, node_modules/.git'i atlar", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "x", "utf8");
    await writeFile(join(dir, "b.txt"), "y", "utf8");
    await writeFile(join(dir, "node_modules/pkg/index.js"), "z", "utf8");
    await writeFile(join(dir, ".git/config"), "c", "utf8");

    const found: string[] = [];
    for await (const p of walkFiles(dir)) found.push(relative(dir, p));
    expect(found.sort()).toEqual(["b.txt", "src/a.ts"]);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/walk.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/walk.ts` yaz**

```typescript
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".horsecode"]);

/** root altındaki dosyaların mutlak yollarını yield eder; SKIP_DIRS atlanır. */
export async function* walkFiles(root: string): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // okunamayan dizin → sessizce atla
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(join(root, e.name));
    } else if (e.isFile()) {
      yield join(root, e.name);
    }
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/walk.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/walk.ts test/tools/walk.test.ts
git commit -m "feat: walkFiles (skip-listeli özyinelemeli dosya gezici)"
```

---

### Task 6: grep (safe)

**Files:**
- Create: `src/tools/grep.ts`
- Test: `test/tools/grep.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`); `walkFiles` (`./walk.js`)
- Produces: `export const grepTool: Tool` — `name:"grep"`, `safe`, `parameters: { pattern: string; flags?: string }`. cwd altında satır bazlı regex arar; `<göreli-yol>:<satır>:<metin>` satırları döner (en çok 200), eşleşme yoksa bilgilendirir. Bozuk regex → `isError`.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/grep.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../../src/tools/grep.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-grep-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("grep", () => {
  it("eşleşen satırları yol:satır:metin biçiminde döner", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "const foo = 1;\nconst bar = 2;", "utf8");
    const res = await grepTool.run({ pattern: "foo" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("src/a.ts:1:const foo = 1;");
    expect(res.content).not.toContain("bar");
  });

  it("eşleşme yoksa bilgilendirir (isError:false)", async () => {
    await writeFile(join(dir, "a.txt"), "hiçbir şey", "utf8");
    const res = await grepTool.run({ pattern: "zzz" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("eşleşme yok");
  });

  it("bozuk regex'te isError döner", async () => {
    const res = await grepTool.run({ pattern: "(" }, ctx());
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/grep.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/grep.ts` yaz**

```typescript
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { walkFiles } from "./walk.js";

const params = z.object({ pattern: z.string(), flags: z.string().optional() });
const MAX_MATCHES = 200;

export const grepTool: Tool = {
  name: "grep",
  description: "cwd altındaki dosyalarda satır bazlı regex araması yapar.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const a = params.parse(rawArgs);
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.flags ?? "");
    } catch (e) {
      return {
        content: `grep: geçersiz regex: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const out: string[] = [];
    for await (const abs of walkFiles(ctx.cwd)) {
      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // ikili dosyayı atla
      const rel = relative(ctx.cwd, abs);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel}:${i + 1}:${lines[i]}`);
          if (out.length >= MAX_MATCHES) {
            out.push(`… (${MAX_MATCHES}+ eşleşme, kesildi)`);
            return { content: out.join("\n"), isError: false };
          }
        }
      }
    }
    return { content: out.length ? out.join("\n") : "eşleşme yok", isError: false };
  },
};
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/grep.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/grep.ts test/tools/grep.test.ts
git commit -m "feat: grep tool (regex satır araması, ikili/skip guard)"
```

---

### Task 7: glob (safe)

**Files:**
- Create: `src/tools/glob.ts`
- Test: `test/tools/glob.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`); `walkFiles` (`./walk.js`); `picomatch`
- Produces: `export const globTool: Tool` — `name:"glob"`, `safe`, `parameters: { pattern: string }`. cwd altında glob'a uyan **göreli** yolları döner (en çok 500), yoksa bilgilendirir.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/glob.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../../src/tools/glob.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-glob-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("glob", () => {
  it("desene uyan göreli yolları döner", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "", "utf8");
    await writeFile(join(dir, "src/b.js"), "", "utf8");
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("src/a.ts");
    expect(res.content).not.toContain("src/b.js");
  });

  it("eşleşme yoksa bilgilendirir", async () => {
    await writeFile(join(dir, "a.txt"), "", "utf8");
    const res = await globTool.run({ pattern: "**/*.rs" }, ctx());
    expect(res.content).toContain("eşleşme yok");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/glob.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/glob.ts` yaz**

```typescript
import { relative, sep } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { walkFiles } from "./walk.js";

const params = z.object({ pattern: z.string() });
const MAX_RESULTS = 500;

export const globTool: Tool = {
  name: "glob",
  description: "cwd altında glob desenine uyan dosya yollarını bulur.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const a = params.parse(rawArgs);
    const isMatch = picomatch(a.pattern);
    const out: string[] = [];
    for await (const abs of walkFiles(ctx.cwd)) {
      // picomatch POSIX ayraç bekler; Windows'ta normalize et.
      const rel = relative(ctx.cwd, abs).split(sep).join("/");
      if (isMatch(rel)) {
        out.push(rel);
        if (out.length >= MAX_RESULTS) {
          out.push(`… (${MAX_RESULTS}+ sonuç, kesildi)`);
          break;
        }
      }
    }
    return { content: out.length ? out.join("\n") : "eşleşme yok", isError: false };
  },
};
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/glob.test.ts`
Expected: PASS (2 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/glob.ts test/tools/glob.test.ts
git commit -m "feat: glob tool (picomatch + walkFiles)"
```

---

### Task 8: shell (exec)

**Files:**
- Create: `src/tools/shell.ts`
- Test: `test/tools/shell.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolResult` (`src/core/types.js`); `node:child_process`
- Produces: `export const shellTool: Tool` — `name:"shell"`, `exec`, `parameters: { command: string }`. `describe` → `{ allowKey: command, preview: command }`. `run`: `spawn(command, { cwd, shell:true, signal })`; stdout+stderr toplar; `close` kodu ≠ 0 → `isError:true`; süreç hatası/abort → `isError:true`.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/shell.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { shellTool } from "../../src/tools/shell.js";

const ctx = (signal?: AbortSignal) => ({
  cwd: tmpdir(),
  signal: signal ?? new AbortController().signal,
});

describe("shell", () => {
  it("başarılı komutun çıktısını döner (exit 0)", async () => {
    const res = await shellTool.run({ command: "echo merhaba" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("merhaba");
  });

  it("başarısız komutta isError:true döner", async () => {
    const res = await shellTool.run({ command: "exit 3" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("3");
  });

  it("describe komutu allowKey + preview yapar", () => {
    const d = shellTool.describe!({ command: "npm test" });
    expect(d.allowKey).toBe("npm test");
    expect(d.preview).toBe("npm test");
  });

  it("önceden iptal edilmiş signal'de isError döner", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await shellTool.run({ command: "echo x" }, ctx(ac.signal));
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/shell.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/shell.ts` yaz**

```typescript
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../core/types.js";

const params = z.object({ command: z.string() });

export const shellTool: Tool = {
  name: "shell",
  description: "Bir shell komutu çalıştırır (cwd bağlamında). stdout+stderr ve çıkış kodunu döner.",
  permissionLevel: "exec",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.command, preview: a.command };
  },
  run(rawArgs, ctx) {
    const a = params.parse(rawArgs);
    return new Promise<ToolResult>((resolvePromise) => {
      let child;
      try {
        child = spawn(a.command, { cwd: ctx.cwd, shell: true, signal: ctx.signal });
      } catch (e) {
        resolvePromise({
          content: `shell hatası: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        });
        return;
      }
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        resolvePromise({ content: `shell hatası: ${e.message}`, isError: true });
      });
      child.on("close", (code) => {
        const body = [out, err].filter((s) => s.length).join("\n").trimEnd();
        resolvePromise({
          content: `$ ${a.command}\n${body}\n(exit ${code ?? "null"})`,
          isError: code !== 0,
        });
      });
    });
  },
};
```

> Not: `spawn` `signal` seçeneği; önceden iptal edilmiş signal 'error' event'i (AbortError) yayar → `isError`. `child.on("error")` ile `child.on("close")` aynı Promise'i çözer; ilk çözüm kazanır (Promise idempotent).

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/shell.test.ts`
Expected: PASS (4 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/shell.ts test/tools/shell.test.ts
git commit -m "feat: shell tool (spawn + abort + exit kodu)"
```

---

### Task 9: web_fetch (safe, enjekte edilebilir fetch)

**Files:**
- Create: `src/tools/web.ts`
- Test: `test/tools/web.test.ts`

**Interfaces:**
- Consumes: `Tool` (`src/core/types.js`)
- Produces:
  - `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`
  - `createWebFetchTool(fetchFn?: FetchLike): Tool` — `name:"web_fetch"`, `safe`, `parameters: { url: string(url) }`. URL'yi çeker, metni döner (100k karaktere kesilir); `!res.ok` → `isError`. `fetchFn` enjekte edilebilir (ağsız test); varsayılan `globalThis.fetch`.

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/web.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { createWebFetchTool, type FetchLike } from "../../src/tools/web.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

describe("web_fetch", () => {
  it("200 yanıtın gövdesini döner", async () => {
    const fetch: FetchLike = async () => new Response("merhaba dünya", { status: 200 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res).toEqual({ content: "merhaba dünya", isError: false });
  });

  it("hata durumunda (4xx) isError:true", async () => {
    const fetch: FetchLike = async () => new Response("not found", { status: 404 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com/x" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("fetch reddi isError'a dönüşür (throw etmez)", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ağ yok");
    };
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("ağ yok");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/web.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/web.ts` yaz**

```typescript
import { z } from "zod";
import type { Tool } from "../core/types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const params = z.object({ url: z.string().url() });
const MAX_CHARS = 100_000;

export function createWebFetchTool(fetchFn: FetchLike = globalThis.fetch as FetchLike): Tool {
  return {
    name: "web_fetch",
    description: "Bir URL'nin içeriğini (metin) çeker.",
    permissionLevel: "safe",
    parameters: params,
    async run(rawArgs, ctx) {
      const a = params.parse(rawArgs);
      try {
        const res = await fetchFn(a.url, { signal: ctx.signal });
        const text = await res.text();
        const capped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n… (kesildi)" : text;
        return { content: capped, isError: !res.ok };
      } catch (e) {
        return {
          content: `web_fetch hatası: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npx vitest run test/tools/web.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Commit**

```bash
git add src/tools/web.ts test/tools/web.test.ts
git commit -m "feat: web_fetch tool (enjekte edilebilir fetch)"
```

---

### Task 10: Varsayılan Registry Montajı

**Files:**
- Create: `src/tools/index.ts`
- Test: `test/tools/index.test.ts`

**Interfaces:**
- Consumes: `ToolRegistry` (`./registry.js`); tüm tool'lar (`./read.js`, `./write.js`, `./edit.js`, `./grep.js`, `./glob.js`, `./shell.js`, `./web.js`)
- Produces: `createDefaultRegistry(): ToolRegistry` — 7 MVP tool'unu kayıtlı bir registry döner. (Dilim C engine bunu tüketir.)

- [ ] **Step 1: Başarısız testi yaz**

`test/tools/index.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../src/tools/index.js";

describe("createDefaultRegistry", () => {
  it("7 MVP tool'unu doğru permission seviyeleriyle kaydeder", () => {
    const reg = createDefaultRegistry();
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual(
      ["edit_file", "glob", "grep", "read_file", "shell", "web_fetch", "write_file"].sort(),
    );
    expect(reg.get("read_file")?.permissionLevel).toBe("safe");
    expect(reg.get("write_file")?.permissionLevel).toBe("write");
    expect(reg.get("shell")?.permissionLevel).toBe("exec");
  });

  it("schemas() her tool için isim + JSON Schema üretir", () => {
    const reg = createDefaultRegistry();
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(7);
    for (const s of schemas) {
      expect(typeof s.name).toBe("string");
      expect(s.parameters).toMatchObject({ type: "object" });
    }
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/tools/index.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/tools/index.ts` yaz**

```typescript
import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { shellTool } from "./shell.js";
import { createWebFetchTool } from "./web.js";

export { ToolRegistry } from "./registry.js";

/** MVP'nin 7 tool'unu kayıtlı bir ToolRegistry döner. */
export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(readFileTool);
  reg.register(writeFileTool);
  reg.register(editFileTool);
  reg.register(grepTool);
  reg.register(globTool);
  reg.register(shellTool);
  reg.register(createWebFetchTool());
  return reg;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm testler**

Run: `npx vitest run test/tools/index.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; typecheck hatasız.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts
git commit -m "feat: createDefaultRegistry (7 MVP tool montajı)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B1 provider + B2 tools)
- [ ] `git log --oneline` — bu dilimde 10 commit
- [ ] `createDefaultRegistry().schemas()` 7 tool şeması üretir (LLM'e gönderime hazır)

Bu dilim şunu teslim eder: 7 tam test edilmiş tool + `describe()` ile permission entegrasyonu + `ToolRegistry`. Sonraki dilim **C — Role-agent iç döngüsü** bu registry'yi (`schemas()` → provider'a; `run()` → permission `check` sonrası) ve B1 provider'ını tüketerek tek bir role-agent tool-calling loop'unu kurar.

## Kapsam Dışı (bilinçli — sonraki dilimler)

- `web_search` (arama backend'i/anahtarı gerekir → ayrı dilim). Bu dilim yalnızca `web_fetch` sunar.
- `.gitignore` tabanlı filtreleme; ripgrep entegrasyonu; ikili dosya için gelişmiş tespit (grep naif `\u0000` kontrolü kullanır).
- Permission `check`'in tool çağrılarına gerçekten uygulanması — engine'in işi (Dilim C/E). Bu dilim yalnızca `describe()` verisini üretir.
- read_file için satır aralığı / büyük-dosya truncation (MVP: tam içerik).
