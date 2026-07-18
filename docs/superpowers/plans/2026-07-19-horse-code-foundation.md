# horse-code Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal coding agent'ın (`horse-code`, CLI: `hcode`) çekirdek altyapısını kurmak — proje iskeleti, katmanlı config, izin motoru ve tüm çekirdek tip tanımları — headless ve tam test edilebilir şekilde.

**Architecture:** Katmanlı mimarinin en alt iki katmanı burada inşa edilir: (1) çekirdek domain tipleri (Message, event, Provider/Tool arayüzleri, izin tipleri) ve (2) yan hizmetler (config yükleme, izin motoru). UI ve agent loop bu dilimde YOK — hepsi UI-agnostik, saf fonksiyonlar/sınıflar olarak yazılır ve `vitest` ile test edilir.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `zod` (şema + doğrulama), `picomatch` (glob eşleştirme), `vitest` (test), `tsup` (build).

## Global Constraints

- Node ≥ 20 (yerleşik `fetch`, `AbortController` kullanılır — polyfill yok).
- TypeScript ESM (`"type": "module"`), `strict: true`, `moduleResolution: "bundler"`.
- Tüm dosya yolları içe aktarımda uzantısız değil — ESM'de relative import'lar `.js` uzantılı yazılır (TS `bundler` çözümüyle uyumlu; `tsup` çıktısı ESM).
- API key **asla** proje config'inde (`.horsecode/config.json`) tutulmaz — yalnızca global config veya env.
- Config katman önceliği (üst alttakini ezer): yerleşik varsayılan → global (`~/.horsecode/config.json`) → proje (`.horsecode/config.json`) → env (`OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`).
- İzin seviyeleri: `'safe' | 'write' | 'exec'`. İzin modları: `'ask' | 'acceptEdits' | 'auto'`.
- MVP dışı (bu dilimde ve genelde YOK): compaction, MCP, plugin, çoklu provider, sandboxing.
- Test framework `vitest`; her task TDD ile (önce başarısız test).

---

### Task 1: Proje İskeleti + Smoke Test

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `src/version.ts`
- Test: `test/version.test.ts`

**Interfaces:**
- Consumes: (yok — ilk task)
- Produces: `src/version.ts` → `export const VERSION: string` (diğer task'lar sürüm string'ini buradan alır). Çalışan `npm test` ve `npm run build` altyapısı.

- [ ] **Step 1: `package.json` oluştur**

```json
{
  "name": "horse-code",
  "version": "0.0.0",
  "description": "Terminal coding agent",
  "type": "module",
  "bin": { "hcode": "./dist/cli.js" },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "picomatch": "^4.0.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/picomatch": "^3.0.1",
    "tsup": "^8.2.4",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: `tsconfig.json` oluştur**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: `vitest.config.ts` ve `tsup.config.ts` oluştur**

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

`tsup.config.ts`:
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  target: "node20",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

> Not: `src/cli.tsx` henüz yok (Dilim 4'te gelecek). `npm run build` bu dilimde çalıştırılmaz; sadece `tsup.config.ts` ileriye hazır durur. Bu dilimde doğrulama `npm test` ve `npm run typecheck` iledir.

- [ ] **Step 4: Bağımlılıkları kur**

Run: `npm install`
Expected: `node_modules/` oluşur, hata yok.

- [ ] **Step 5: Başarısız testi yaz**

`test/version.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("semver formatında bir string döner", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 6: Testin başarısız olduğunu doğrula**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/version.js'`.

- [ ] **Step 7: `src/version.ts` yaz**

```typescript
export const VERSION = "0.0.0";
```

- [ ] **Step 8: Testin geçtiğini doğrula**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: hata yok, çıktı boş.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts tsup.config.ts src/version.ts test/version.test.ts package-lock.json
git commit -m "chore: proje iskeleti + smoke test"
```

---

### Task 2: Çekirdek Domain Tipleri

**Files:**
- Create: `src/core/types.ts`
- Test: `test/core/types.test.ts`

**Interfaces:**
- Consumes: (yok — saf tip tanımları)
- Produces: Aşağıdaki tüm tipler diğer dilimlerce kullanılır. Kritik olanlar:
  - `Role = "system" | "user" | "assistant" | "tool"`
  - `Message` — `{ role, content, toolCalls?, toolCallId?, name? }`
  - `ToolCall` — `{ id: string; name: string; arguments: string }` (arguments ham JSON string)
  - `ToolResult` — `{ content: string; isError: boolean }`
  - `PermissionLevel = "safe" | "write" | "exec"`
  - `PermissionMode = "ask" | "acceptEdits" | "auto"`
  - `Tool` arayüzü — `{ name, description, permissionLevel, parameters (zod), run(args, ctx): Promise<ToolResult> }`
  - `ToolContext` — `{ cwd: string; signal: AbortSignal }`
  - `Provider` arayüzü — `chat(req, signal): AsyncIterable<ChatEvent>`
  - `ChatRequest`, `ChatEvent` (`text-delta` | `tool-call` | `usage` | `done` | `error`)
  - `AgentEvent` (UI'nın abone olduğu üst-seviye event union)

- [ ] **Step 1: Başarısız testi yaz**

`test/core/types.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Tool, Message, ChatEvent, AgentEvent } from "../../src/core/types.js";
import { isTextDelta, isToolCallEvent } from "../../src/core/types.js";

describe("core types", () => {
  it("Tool arayüzü zod parameters ile uyumlu bir nesneyi kabul eder", async () => {
    const tool: Tool = {
      name: "echo",
      description: "girdiyi döner",
      permissionLevel: "safe",
      parameters: z.object({ text: z.string() }),
      run: async (args) => ({ content: String(args.text), isError: false }),
    };
    const result = await tool.run({ text: "merhaba" }, {
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ content: "merhaba", isError: false });
  });

  it("Message tipi tool çağrılarını taşıyabilir", () => {
    const msg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "echo", arguments: '{"text":"hi"}' }],
    };
    expect(msg.toolCalls?.[0].name).toBe("echo");
  });

  it("ChatEvent tip guard'ları doğru ayrım yapar", () => {
    const delta: ChatEvent = { type: "text-delta", text: "x" };
    const call: ChatEvent = {
      type: "tool-call",
      toolCall: { id: "1", name: "echo", arguments: "{}" },
    };
    expect(isTextDelta(delta)).toBe(true);
    expect(isTextDelta(call)).toBe(false);
    expect(isToolCallEvent(call)).toBe(true);
  });

  it("AgentEvent union'ı permission.ask event'ini içerir", () => {
    const ev: AgentEvent = {
      type: "permission.ask",
      requestId: "r1",
      toolName: "shell",
      permissionLevel: "exec",
      preview: "npm test",
    };
    expect(ev.type).toBe("permission.ask");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npm test test/core/types.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/types.js'`.

- [ ] **Step 3: `src/core/types.ts` yaz**

```typescript
import type { z } from "zod";

// --- Mesajlar ---
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // ham JSON string (LLM'den geldiği gibi)
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[]; // assistant mesajlarında
  toolCallId?: string; // role === "tool" olan mesajlarda
  name?: string; // tool adı (role === "tool")
}

// --- Tool'lar ---
export type PermissionLevel = "safe" | "write" | "exec";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;
  parameters: z.ZodType;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// --- Provider (LLM gateway) ---
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: { name: string; description: string; parameters: unknown }[];
}

export type ChatEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" }
  | { type: "error"; message: string };

export interface Provider {
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

// --- Agent event stream (UI bunlara abone olur) ---
export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "message.done"; message: Message }
  | { type: "tool.request"; toolCall: ToolCall }
  | { type: "tool.result"; toolCallId: string; result: ToolResult }
  | {
      type: "permission.ask";
      requestId: string;
      toolName: string;
      permissionLevel: PermissionLevel;
      preview: string;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string }
  | { type: "abort" };

// --- Tip guard'lar ---
export function isTextDelta(
  e: ChatEvent,
): e is Extract<ChatEvent, { type: "text-delta" }> {
  return e.type === "text-delta";
}

export function isToolCallEvent(
  e: ChatEvent,
): e is Extract<ChatEvent, { type: "tool-call" }> {
  return e.type === "tool-call";
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npm test test/core/types.test.ts`
Expected: PASS (4 test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts test/core/types.test.ts
git commit -m "feat: çekirdek domain tipleri (Message, Tool, Provider, event union)"
```

---

### Task 3: Katmanlı Config Yükleme

**Files:**
- Create: `src/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Consumes: (yok)
- Produces:
  - `ResolvedConfig` — `{ apiKey?: string; baseUrl: string; model: string; mode: PermissionMode; allowlist: string[] }`
  - `loadConfig(opts: { cwd: string; home: string; env: NodeJS.ProcessEnv; readFile: (p: string) => string | undefined }): ResolvedConfig` — saf, enjekte edilebilir; dosya sistemi ve env dışarıdan geçilir (test edilebilirlik).
  - `DEFAULT_CONFIG` — yerleşik varsayılanlar.

> Tasarım notu: `loadConfig` doğrudan `fs` okumaz; `readFile` fonksiyonu enjekte edilir. Böylece testler tamamen bellekte çalışır. Gerçek `fs`-bağlı sarmalayıcı Dilim 4'teki CLI'da eklenir.

- [ ] **Step 1: Başarısız testi yaz**

`test/config/config.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/config.js";

const noFiles = () => undefined;

describe("loadConfig", () => {
  it("hiçbir kaynak yoksa varsayılanları döner", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: noFiles });
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.mode).toBe("ask");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.allowlist).toEqual([]);
  });

  it("global config değerleri varsayılanı ezer", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ model: "gpt-x", apiKey: "sk-global", mode: "acceptEdits" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.apiKey).toBe("sk-global");
    expect(cfg.mode).toBe("acceptEdits");
  });

  it("proje config global'i ezer ama apiKey'i yok sayar", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ model: "global-model", apiKey: "sk-global" });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ model: "proj-model", apiKey: "sk-LEAK", allowlist: ["npm test"] });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("proj-model");
    expect(cfg.apiKey).toBe("sk-global"); // proje apiKey'i yok sayıldı
    expect(cfg.allowlist).toEqual(["npm test"]);
  });

  it("env değişkenleri en yüksek önceliğe sahiptir", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ apiKey: "sk-global", baseUrl: "https://global" })
        : undefined;
    const cfg = loadConfig({
      cwd: "/proj",
      home: "/home",
      env: { OMNIROUTE_API_KEY: "sk-env", OMNIROUTE_BASE_URL: "https://env" },
      readFile,
    });
    expect(cfg.apiKey).toBe("sk-env");
    expect(cfg.baseUrl).toBe("https://env");
  });

  it("bozuk JSON'da o katmanı yok sayar, çökmeden devam eder", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json" ? "{ bozuk json" : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.mode).toBe("ask"); // varsayılana düştü
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npm test test/config/config.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/config/config.ts` yaz**

```typescript
import { z } from "zod";
import type { PermissionMode } from "../core/types.js";

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mode: PermissionMode;
  allowlist: string[];
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  baseUrl: "https://api.omniroute.example/v1",
  model: "default",
  mode: "ask",
  allowlist: [],
};

// Dosyalardan okunabilecek alanlar (hepsi opsiyonel).
const fileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "acceptEdits", "auto"]).optional(),
    allowlist: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

type FileConfig = z.infer<typeof fileSchema>;

function parseFile(raw: string | undefined): FileConfig {
  if (!raw) return {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {}; // bozuk JSON → katmanı yok say
  }
}

export interface LoadOptions {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | undefined;
}

export function loadConfig(opts: LoadOptions): ResolvedConfig {
  const global = parseFile(opts.readFile(`${opts.home}/.horsecode/config.json`));
  const project = parseFile(opts.readFile(`${opts.cwd}/.horsecode/config.json`));

  // Güvenlik: proje config'i apiKey taşıyamaz.
  const { apiKey: _leak, ...projectSafe } = project;

  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...global,
    ...projectSafe,
  } as ResolvedConfig;

  // allowlist için birleştirme yerine "en spesifik kazanır" (project varsa onu al).
  merged.allowlist = projectSafe.allowlist ?? global.allowlist ?? [];

  // env en yüksek öncelik.
  if (opts.env.OMNIROUTE_API_KEY) merged.apiKey = opts.env.OMNIROUTE_API_KEY;
  if (opts.env.OMNIROUTE_BASE_URL) merged.baseUrl = opts.env.OMNIROUTE_BASE_URL;

  return merged;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula**

Run: `npm test test/config/config.test.ts`
Expected: PASS (5 test).

- [ ] **Step 5: Typecheck + tüm testler**

Run: `npm run typecheck && npm test`
Expected: hata yok, tüm testler PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: katmanlı config yükleme (proje key sızıntısını engeller)"
```

---

### Task 4: İzin Motoru (modlar + allowlist + tehlikeli desen)

**Files:**
- Create: `src/permission/rules.ts`
- Create: `src/permission/engine.ts`
- Test: `test/permission/engine.test.ts`

**Interfaces:**
- Consumes: `PermissionLevel`, `PermissionMode` (`src/core/types.js`)
- Produces:
  - `PermissionDecision = "allow" | "ask" | "deny"`
  - `PermissionRequest` — `{ level: PermissionLevel; preview: string; allowKey: string }` (`allowKey`: shell için komut, dosya için hedef yol/glob)
  - `class PermissionEngine` — kurucu `(opts: { mode: PermissionMode; allowlist: string[] })`; metotlar:
    - `check(req: PermissionRequest): PermissionDecision`
    - `addAllow(rule: string): void` (session allowlist'e ekler)
    - `get mode(): PermissionMode` / `setMode(m): void`
  - `matchesAllowlist(allowKey: string, rules: string[]): boolean` (rules.ts) — prefix (shell) veya glob (dosya) eşleştirme.
  - `isDangerous(command: string): boolean` (rules.ts) — kaba tehlikeli desen kontrolü.

- [ ] **Step 1: `rules.ts` için başarısız testi yaz**

`test/permission/engine.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { matchesAllowlist, isDangerous } from "../../src/permission/rules.js";
import { PermissionEngine } from "../../src/permission/engine.js";

describe("matchesAllowlist", () => {
  it("shell komutunda prefix eşleşmesi yapar", () => {
    expect(matchesAllowlist("npm test --watch", ["npm test"])).toBe(true);
    expect(matchesAllowlist("npm publish", ["npm test"])).toBe(false);
  });

  it("dosya yolunda glob eşleşmesi yapar", () => {
    expect(matchesAllowlist("src/app/index.ts", ["src/**"])).toBe(true);
    expect(matchesAllowlist("secrets/key.pem", ["src/**"])).toBe(false);
  });

  it("boş allowlist hiçbir şeyi eşleştirmez", () => {
    expect(matchesAllowlist("anything", [])).toBe(false);
  });
});

describe("isDangerous", () => {
  it("yıkıcı komutları yakalar", () => {
    expect(isDangerous("rm -rf /")).toBe(true);
    expect(isDangerous("sudo rm -rf /*")).toBe(true);
    expect(isDangerous(":(){ :|:& };:")).toBe(true);
  });
  it("normal komutları güvenli sayar", () => {
    expect(isDangerous("npm test")).toBe(false);
    expect(isDangerous("git status")).toBe(false);
  });
});

describe("PermissionEngine", () => {
  it("safe seviye her modda onaysız izin verir", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "safe", preview: "read", allowKey: "x" })).toBe("allow");
  });

  it("ask modunda write/exec için sorar", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("ask");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("acceptEdits modunda write otomatik, exec sorar", () => {
    const eng = new PermissionEngine({ mode: "acceptEdits", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("auto modunda her şey otomatik ama tehlikeli komut yine sorar", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "rm -rf /", allowKey: "rm -rf /" })).toBe("ask");
  });

  it("allowlist eşleşmesi ask modunda bile izin verir", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: ["git status"] });
    expect(eng.check({ level: "exec", preview: "git status", allowKey: "git status" })).toBe("allow");
  });

  it("addAllow ile eklenen kural sonraki kontrolde geçerli olur", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("ask");
    eng.addAllow("ls");
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("allow");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npm test test/permission/engine.test.ts`
Expected: FAIL — modüller bulunamadı.

- [ ] **Step 3: `src/permission/rules.ts` yaz**

```typescript
import picomatch from "picomatch";

// Tehlikeli komut desenleri (kaba, tam kapsayıcı değil — auto modda ek güvenlik).
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*\s\/(\*|\s|$)/, // rm -rf / veya /*
  /\brm\s+-rf\s+\/(\*|$)/,
  /:\(\)\s*\{.*\|.*&.*\}\s*;/, // fork bomb :(){ :|:& };:
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\/(sd|hd|nvme)/,
  /\b(sudo\s+)?chmod\s+-R\s+000\s+\//,
  /\s>\s*\/dev\/sd[a-z]/,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

/**
 * allowKey bir kurala uyuyor mu?
 * - Glob görünümlü kurallar (`*`, `?`, `[`, `/` içeren) picomatch ile eşleştirilir (dosya yolları).
 * - Diğerleri prefix eşleşmesi (shell komutları: "npm test" → "npm test --watch").
 */
export function matchesAllowlist(allowKey: string, rules: string[]): boolean {
  for (const rule of rules) {
    const looksGlob = /[*?\[\]]/.test(rule) || rule.includes("/");
    if (looksGlob) {
      if (picomatch(rule)(allowKey)) return true;
    } else {
      if (allowKey === rule || allowKey.startsWith(rule + " ")) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: `src/permission/engine.ts` yaz**

```typescript
import type { PermissionLevel, PermissionMode } from "../core/types.js";
import { matchesAllowlist, isDangerous } from "./rules.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRequest {
  level: PermissionLevel;
  preview: string;
  allowKey: string; // shell: komut · dosya: hedef yol
}

export class PermissionEngine {
  private _mode: PermissionMode;
  private allowlist: string[];

  constructor(opts: { mode: PermissionMode; allowlist: string[] }) {
    this._mode = opts.mode;
    this.allowlist = [...opts.allowlist];
  }

  get mode(): PermissionMode {
    return this._mode;
  }

  setMode(m: PermissionMode): void {
    this._mode = m;
  }

  addAllow(rule: string): void {
    if (!this.allowlist.includes(rule)) this.allowlist.push(rule);
  }

  check(req: PermissionRequest): PermissionDecision {
    // safe her zaman serbest.
    if (req.level === "safe") return "allow";

    // Allowlist eşleşmesi her modda geçerli (tehlikeli değilse).
    const isExec = req.level === "exec";
    const dangerous = isExec && isDangerous(req.allowKey);

    if (!dangerous && matchesAllowlist(req.allowKey, this.allowlist)) {
      return "allow";
    }

    switch (this._mode) {
      case "ask":
        return "ask";
      case "acceptEdits":
        return req.level === "write" ? "allow" : "ask";
      case "auto":
        return dangerous ? "ask" : "allow";
    }
  }
}
```

- [ ] **Step 5: Testin geçtiğini doğrula**

Run: `npm test test/permission/engine.test.ts`
Expected: PASS (tüm alt testler).

- [ ] **Step 6: Typecheck + tüm testler**

Run: `npm run typecheck && npm test`
Expected: hata yok, tüm dilim testleri PASS.

- [ ] **Step 7: Commit**

```bash
git add src/permission/rules.ts src/permission/engine.ts test/permission/engine.test.ts
git commit -m "feat: izin motoru (modlar + allowlist + tehlikeli desen kontrolü)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (version, types, config, permission)
- [ ] `git log --oneline` — 5 commit (iskele + 4 özellik)

Bu dilim şunları teslim eder: çalışan build/test altyapısı, tüm çekirdek tipler, katmanlı config yükleme ve tam test edilmiş izin motoru. Sonraki dilim (**Tools**) bu tipleri ve izin motorunu tüketerek 7 tool'u ve registry'yi inşa eder.

---

## Sonraki Dilimler (bu planın kapsamı DIŞINDA — ayrı plan olarak yazılacak)

- **Dilim 2 — Tools:** `ToolRegistry` + `read/grep/glob/write/edit/shell/web` tool'ları. Her tool `Tool` arayüzünü uygular, `PermissionEngine` ile entegre onay `allowKey` üretir.
- **Dilim 3 — Engine + Provider:** `AgentEngine` (event yayan loop), `MockProvider` (test), `OmniRouteProvider` (OpenAI-uyumlu stream + tools), `Session` (jsonl kayıt + resume).
- **Dilim 4 — TUI + CLI:** Ink `App`, `MessageList`/`Composer`/`PermissionDialog`/`DiffView`, `cli.tsx` girişi, onboarding, `/model` `/mode` slash komutları.
