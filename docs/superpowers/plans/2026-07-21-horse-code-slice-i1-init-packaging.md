# Dilim I1 — init + packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hcode init` interaktif kurulumu (global config) + `npm i -g`/`npm link` için build.

**Architecture:** `runInit` enjekte-IO ile test edilebilir; `main` en başında `init` subcommand'ini gerçek IO'ya (readline+fs) bağlar; `package.json prepare` build'i otomatikler.

**Tech Stack:** TypeScript ESM, vitest. Yeni bağımlılık yok.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**. `runInit` saf/enjekte-IO ile tam test edilir; `main` routing + packaging **manuel** doğrulanır.
- **Güvenlik:** apiKey **global** `~/.horsecode/config.json`'a yazılır; apiKey değeri **log'a yazılmaz**.
- **Merge-koru:** mevcut config alanları (`mode`/`roles`/`council`/`allowlist`) korunur; yalnız `baseUrl`/`model`/`apiKey` güncellenir. Model default `auto/best-coding` (mevcut model varsa korunur).
- Regresyon: tüm suite + typecheck yeşil.

---

### Task 1: `runInit` (`src/init.ts`)

**Files:**
- Create: `src/init.ts`
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: `LineReader` (`src/terminal.ts`).
- Produces: `interface InitIO { read: LineReader; readFile: (p: string) => string | undefined; writeFile: (p: string, content: string) => void; home: string; log: (s: string) => void }`; `runInit(io: InitIO): Promise<void>`.

- [ ] **Step 1: Kırmızı test**

`test/init.test.ts` oluştur:
```typescript
import { describe, it, expect } from "vitest";
import { runInit, type InitIO } from "../src/init.js";

function mkIO(answers: string[], existing?: string) {
  let i = 0;
  const writes: { path: string; content: string }[] = [];
  const logs: string[] = [];
  const io: InitIO = {
    read: async () => answers[i++] ?? "",
    readFile: () => existing,
    writeFile: (path, content) => { writes.push({ path, content }); },
    home: "/home/u",
    log: (s) => { logs.push(s); },
  };
  return { io, writes, logs };
}

describe("runInit", () => {
  it("boş baseUrl → default; apiKey yazılır", async () => {
    const { io, writes } = mkIO(["", "secret-key"]);
    await runInit(io);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/home/u/.horsecode/config.json");
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.baseUrl).toBe("http://localhost:20128");
    expect(cfg.model).toBe("auto/best-coding");
    expect(cfg.apiKey).toBe("secret-key");
  });

  it("girilen baseUrl kullanılır; boş apiKey → apiKey yok", async () => {
    const { io, writes } = mkIO(["https://gw.example/v", "  "]);
    await runInit(io);
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.baseUrl).toBe("https://gw.example/v");
    expect("apiKey" in cfg).toBe(false);
  });

  it("mevcut alanları korur; mevcut model korunur; boş apiKey öncekini temizler", async () => {
    const existing = JSON.stringify({ mode: "auto", model: "openai/gpt-4o", apiKey: "old", roles: { coder: { models: ["x"] } } });
    const { io, writes } = mkIO(["", ""], existing);
    await runInit(io);
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.mode).toBe("auto");
    expect(cfg.roles).toEqual({ coder: { models: ["x"] } });
    expect(cfg.model).toBe("openai/gpt-4o");
    expect("apiKey" in cfg).toBe(false);
  });

  it("apiKey değeri log'a yazılmaz", async () => {
    const { io, logs } = mkIO(["", "TOPSECRET"]);
    await runInit(io);
    expect(logs.join("\n")).not.toContain("TOPSECRET");
    expect(logs.join("\n")).toContain("apiKey: set");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/init.test.ts`
Expected: FAIL — `src/init.js` yok.

- [ ] **Step 3: `runInit` implement**

`src/init.ts` oluştur:
```typescript
import type { LineReader } from "./terminal.js";

export interface InitIO {
  read: LineReader;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  home: string;
  log: (s: string) => void;
}

const DEFAULT_BASE_URL = "http://localhost:20128";
const DEFAULT_MODEL = "auto/best-coding";

function parseExisting(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** İnteraktif kurulum: baseUrl + apiKey sorar, global config'e merge-koru yazar. */
export async function runInit(io: InitIO): Promise<void> {
  const path = `${io.home}/.horsecode/config.json`;
  const existing = parseExisting(io.readFile(path));
  const baseUrl = (await io.read(`omniroute baseUrl [${DEFAULT_BASE_URL}]: `)).trim() || DEFAULT_BASE_URL;
  const apiKey = (await io.read("omniroute apiKey (boş=yok): ")).trim();
  const config: Record<string, unknown> = {
    ...existing,
    baseUrl,
    model: existing.model ?? DEFAULT_MODEL,
  };
  if (apiKey) config.apiKey = apiKey;
  else delete config.apiKey;
  io.writeFile(path, JSON.stringify(config, null, 2) + "\n");
  io.log(`config yazıldı: ${path} (apiKey: ${apiKey ? "set" : "yok"})`);
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/init.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tümü yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/init.ts test/init.test.ts
git commit -m "feat: runInit (interaktif omniroute kurulumu, merge-koru global config)"
```

---

### Task 2: Arg-routing + packaging

**Files:**
- Modify: `src/cli.ts` (init subcommand routing + import'lar)
- Modify: `package.json` (`prepare` script)

**Interfaces:**
- Consumes: `runInit` (`src/init.ts`), `nodeLineReader` (`src/terminal.ts`).

- [ ] **Step 1: cli.ts import'larını genişlet**

`src/cli.ts`:
- Satır 2: `import { readFileSync, existsSync } from "node:fs";` → `import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";`
- Satır 3: `import { join } from "node:path";` → `import { join, dirname } from "node:path";`
- Import bloğuna ekle: `import { runInit } from "./init.js";`

- [ ] **Step 2: `main` başına init-routing ekle**

`src/cli.ts` — `export async function main(argv: string[]): Promise<void> {`'in HEMEN altına (mevcut `const args = parseArgs(argv);`'den ÖNCE):

```typescript
  if (argv[0] === "init") {
    const { read, close } = nodeLineReader();
    try {
      await runInit({
        read,
        readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
        writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
        home: process.env.HOME ?? "",
        log: (s) => console.log(s),
      });
    } finally { close(); }
    return;
  }
```

- [ ] **Step 3: package.json `prepare` script**

`package.json` `scripts` içine ekle (`"build": "tsup",` yanına):
```json
    "prepare": "npm run build",
```

- [ ] **Step 4: Tüm suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: tümü yeşil; typecheck temiz; `dist/cli.js` build olur (routing mevcut testleri bozmaz — `init` argümanı yalnız yeni dalı tetikler).

- [ ] **Step 5: Manuel doğrulama (init akışı + kurulum)**

Run:
```bash
npm link
printf 'http://localhost:20128\n\n' | hcode init   # baseUrl gir, apiKey boş
cat ~/.horsecode/config.json
```
Expected: `~/.horsecode/config.json` `{ "baseUrl": "http://localhost:20128", "model": "auto/best-coding" }` içerir (apiKey yok); `hcode` global çalışır. (apiKey verirsen `apiKey` alanı da yazılır, terminalde değer görünmez.)

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat: hcode init subcommand routing + prepare build (npm i -g/link)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 `runInit` → Task 1; §3 arg-routing → Task 2 Step 1-2; §4 packaging → Task 2 Step 3. Tümü karşılandı.
- **Type consistency:** `InitIO` alanları (read/readFile/writeFile/home/log); `runInit(io): Promise<void>`; cli routing gerçek IO'yu `InitIO`'ya map eder (`readFile` try/catch, `writeFile` mkdir+write). `nodeLineReader` `{read, close}`.
- **Güvenlik:** apiKey global config'e; log'da `set/yok` (değer yok) — Task 1 test doğrular. Proje config apiKey-strip mevcut davranışı değişmez.
- **Geriye dönük uyum:** `init` yeni dal; `hcode "<prompt>"` akışı değişmez (routing `init` argümanına özel). Task 2 Step 4 tam suite ile doğrular.
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
