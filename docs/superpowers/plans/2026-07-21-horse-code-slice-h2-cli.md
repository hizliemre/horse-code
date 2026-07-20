# Dilim H2 — CLI + Terminal I/O + Provider Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Çalışan `hcode` CLI: default prompt'lar + `buildJobDeps` wiring + gerçek terminal seam'leri + `cli.ts` giriş. `hcode "<prompt>"` gerçek omniroute'a karşı `runJob`'u koşar.

**Architecture:** `src/prompts.ts` (14 rol varsayılan prompt + councilor'lar), `src/wiring.ts` (config→JobDeps + logPRAdapter stub), `src/terminal.ts` (enjekte reader'lı seam'ler), `src/cli.ts` (parseArgs/renderResult saf + ince main).

**Tech Stack:** TypeScript ESM, vitest, node:readline/promises, tsup (bin build).

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; testler I/O-suz (fake reader/provider/log); `main()` ince, birim test edilmez.
- **PRAdapter stub/log** (gerçek MCP → G); prompt'lar **işlevsel varsayılan** (rafine → G).
- **`resolve` out-of-box:** her `REQUIRED_ROLES` config'te olmasa bile `config.model` + `DEFAULT_PROMPTS` ile çözülür.
- **rounds varsayılan 3** (config `escalation.rounds` ileride).

---

### Task 1: `src/prompts.ts` — Varsayılan prompt'lar

**Files:**
- Create: `src/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Produces: `REQUIRED_ROLES` (14 rol), `DEFAULT_PROMPTS: Record<string,string>`, `DEFAULT_COUNCILORS: CouncilorConfig[]` (models boş → wiring config.model ile doldurur).

- [ ] **Step 1: Kırmızı test**

`test/prompts.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_COUNCILORS } from "../src/prompts.js";

describe("prompts", () => {
  it("her REQUIRED_ROLES için boş olmayan varsayılan prompt var", () => {
    for (const r of REQUIRED_ROLES) {
      expect(DEFAULT_PROMPTS[r], r).toBeDefined();
      expect(DEFAULT_PROMPTS[r].length).toBeGreaterThan(0);
    }
  });
  it("DEFAULT_COUNCILORS ≥1 üye; name+perspective dolu", () => {
    expect(DEFAULT_COUNCILORS.length).toBeGreaterThan(0);
    for (const c of DEFAULT_COUNCILORS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.perspective.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — `prompts.js` yok.

- [ ] **Step 3: prompts.ts implement**

`src/prompts.ts` oluştur:

```typescript
import type { CouncilorConfig } from "./config/config.js";

export const REQUIRED_ROLES = [
  "refiner", "coach", "analyst", "planner", "judge", "project-manager", "team-lead",
  "router", "coder", "designer", "senior-coder", "senior-designer", "architect", "code-reviewer",
] as const;

export const DEFAULT_PROMPTS: Record<string, string> = {
  refiner:
    "Kullanıcının isteğini kısa ve net biçimde refine et ve intent'ini sınıflandır: 'chat' (sohbet/soru), 'feature' (yeni özellik/iş), 'bugfix' (hata düzeltme). Sonucu submit ile {refinedPrompt, intent} olarak döndür.",
  coach:
    "Kullanıcının teknik sorularını yanıtla. Gerekirse read_file/grep/glob ile repoyu incele. Kısa, doğrudan ve yardımcı ol.",
  analyst:
    "Verilen istekten teknik bir spec yaz: amaç, kapsam, kararlar, kabul kriterleri. Belirsiz noktalar için ask_user ile kullanıcıya soru sor. Spec'i verilen dosyaya write_file ile yaz.",
  planner:
    "Verilen spec'i oku ve uygulanabilir bir geliştirme planı yaz: bağımsız task'lar, her birinin amacı ve bağımlılıkları. Planı verilen dosyaya write_file ile yaz.",
  judge:
    "Council değerlendirmelerini sentezle ve tek karar ver: 'pass' (yeterli), 'revise' (gerekçelerle düzeltilsin) veya 'ask-human' (kullanıcıya sorulacak soru). submit ile {decision, feedback, question} döndür.",
  "project-manager":
    "Verilen planı oku ve gerçek, uygulanabilir task'lara böl (id, kısa title, deps). Her task tek ve net bir iş olsun. submit ile {tasks} döndür.",
  "team-lead":
    "Task kartlarını ve bağımlılıklarını incele; deterministik dalga önerisini teyit et veya düzelt. submit ile {waves} döndür.",
  router:
    "Task başlığına bakıp uygulayıcı rolü seç: UI/UX işi için 'designer', diğer kod işleri için 'coder'. submit ile {role} döndür.",
  coder:
    "Verilen task'ı worktree'de uygula. Yeni task ise sıfırdan; dönen task ise reviewer notlarını gider. read/write/edit/grep/glob/shell ile çalış ve testleri koştur.",
  designer:
    "UI/UX task'ını worktree'de uygula. Kullanıcı arayüzü ve deneyimine odaklan; read/write/edit ile çalış.",
  "senior-coder":
    "coder'ın takıldığı task'ı devral; daha dikkatli bir yaklaşımla uygula. Reviewer notlarını ve önceki denemeleri dikkate al.",
  "senior-designer":
    "designer'ın takıldığı UI/UX task'ını devral; daha dikkatli uygula.",
  architect:
    "Tekrar tekrar başarısız olan bir task'ın veya bir merge çakışmasının kök-nedenini analiz et ve somut bir çözüm planı üret. submit ile {rootCause, plan} döndür.",
  "code-reviewer":
    "REVIEW'daki task'ın worktree değişikliklerini incele (doğruluk, test, kalite). submit ile {verdict: pass|fail, notes} döndür — kararın nihaidir.",
};

export const DEFAULT_COUNCILORS: CouncilorConfig[] = [
  { name: "security", perspective: "güvenlik açıkları, secret sızıntısı, girdi doğrulama", models: [] },
  { name: "architecture", perspective: "katman ihlali, bağımlılık yönü, tutarlılık", models: [] },
  { name: "testability", perspective: "test edilebilirlik, izolasyon, kenar durumlar", models: [] },
];
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run: `npm run typecheck`

```bash
git add src/prompts.ts test/prompts.test.ts
git commit -m "feat: varsayılan rol prompt'ları + councilor'lar (prompts.ts)"
```

---

### Task 2: `src/wiring.ts` — `buildJobDeps` + `logPRAdapter`

**Files:**
- Create: `src/wiring.ts`
- Test: `test/wiring.test.ts`

**Interfaces:**
- Consumes: Task 1 prompts; C `RoleRegistry`; Foundation `PermissionEngine`/`ResolvedConfig`/`RoleConfig`; F2 `buildCouncilRegistry`; H1 `JobDeps`; D `WorktreeManager`/`PRAdapter`; E3b `AskHuman`.
- Produces:
  - `buildJobDeps(opts): JobDeps`
  - `logPRAdapter(log: (s: string) => void): PRAdapter`

- [ ] **Step 1: Kırmızı test**

`test/wiring.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { buildJobDeps, logPRAdapter } from "../src/wiring.js";
import { REQUIRED_ROLES } from "../src/prompts.js";
import type { ResolvedConfig } from "../src/config/config.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { WorktreeManager } from "../src/worktree/manager.js";
import type { Provider } from "../src/core/types.js";

const fakeProvider: Provider = { async *chat() { /* buildJobDeps çağırmaz */ } };
function baseConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { baseUrl: "http://x", model: "cc/m", mode: "auto", allowlist: [], roles: {}, ...over };
}
function deps(config: ResolvedConfig) {
  return buildJobDeps({
    config, provider: fakeProvider, skillRegistry: new SkillRegistry(),
    manager: new WorktreeManager({ repoRoot: "/tmp" }),
    prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
    approve: async () => true, signal: new AbortController().signal,
  });
}

describe("buildJobDeps", () => {
  it("her REQUIRED_ROLES resolve olur (config'te olmasa bile)", () => {
    const d = deps(baseConfig());
    for (const r of REQUIRED_ROLES) {
      expect(() => d.roleRegistry.resolve(r), r).not.toThrow();
      expect(d.roleRegistry.resolve(r).model).toBe("cc/m");
    }
  });
  it("council resolve olur; rounds=3; permission mode config'ten", () => {
    const d = deps(baseConfig({ mode: "ask" }));
    expect(d.councilors.length).toBeGreaterThan(0);
    expect(() => d.councilRegistry.resolve(d.councilors[0].name)).not.toThrow();
    expect(d.rounds).toBe(3);
  });
  it("config.roles varsayılanı ezer", () => {
    const d = deps(baseConfig({ roles: { coder: { models: ["özel/m"], systemPrompt: "özel coder" } } }));
    expect(d.roleRegistry.resolve("coder").model).toBe("özel/m");
    expect(d.roleRegistry.resolve("coder").systemPrompt).toContain("özel coder");
  });
});

describe("logPRAdapter", () => {
  it("createPR loglar + placeholder url döner", async () => {
    const logs: string[] = [];
    const r = await logPRAdapter((s) => logs.push(s)).createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(logs[0]).toContain("hc/j/base");
    expect(r.url).toContain("pending");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/wiring.test.ts`
Expected: FAIL — `wiring.js` yok.

- [ ] **Step 3: wiring.ts implement**

`src/wiring.ts` oluştur:

```typescript
import { RoleRegistry } from "./agent/roles.js";
import { PermissionEngine } from "./permission/engine.js";
import type { PermissionRequest } from "./permission/engine.js";
import { buildCouncilRegistry } from "./engine/review.js";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_COUNCILORS } from "./prompts.js";
import type { ResolvedConfig, RoleConfig, CouncilorConfig } from "./config/config.js";
import type { Provider } from "./core/types.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { WorktreeManager, PRAdapter } from "./worktree/manager.js";
import type { AskHuman } from "./engine/escalation.js";
import type { JobDeps } from "./engine/job.js";

export interface BuildJobDepsOpts {
  config: ResolvedConfig;
  provider: Provider;
  skillRegistry: SkillRegistry;
  manager: WorktreeManager;
  prAdapter: PRAdapter;
  askHuman: AskHuman;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
}

/** Config + varsayılanlardan tam bir JobDeps kurar; her rol resolve olur. */
export function buildJobDeps(opts: BuildJobDepsOpts): JobDeps {
  const { config } = opts;
  const roles: Record<string, RoleConfig> = {};
  for (const name of REQUIRED_ROLES) {
    roles[name] = config.roles[name] ?? { models: [config.model] };
  }
  const roleRegistry = new RoleRegistry(roles, DEFAULT_PROMPTS, opts.skillRegistry);

  const councilors: CouncilorConfig[] = (config.council?.councilors ?? DEFAULT_COUNCILORS).map((c) => ({
    ...c,
    models: c.models.length > 0 ? c.models : [config.model],
  }));
  const councilRegistry = buildCouncilRegistry(councilors);

  const permission = new PermissionEngine({ mode: config.mode, allowlist: config.allowlist });

  return {
    provider: opts.provider,
    roleRegistry,
    skillRegistry: opts.skillRegistry,
    permission,
    approve: opts.approve,
    signal: opts.signal,
    councilRegistry,
    councilors,
    manager: opts.manager,
    prAdapter: opts.prAdapter,
    rounds: 3,
    askHuman: opts.askHuman,
  };
}

/** H2 PRAdapter'ı: PR intent'ini loglar + placeholder url döner (gerçek MCP → G). */
export function logPRAdapter(log: (s: string) => void): PRAdapter {
  return {
    async createPR(input) {
      log(`PR açılacaktı: ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(pending: G — gerçek MCP)" };
    },
  };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run: `npm run typecheck`

```bash
git add src/wiring.ts test/wiring.test.ts
git commit -m "feat: buildJobDeps (config→JobDeps) + logPRAdapter stub"
```

---

### Task 3: `src/terminal.ts` — Gerçek terminal seam'leri

**Files:**
- Create: `src/terminal.ts`
- Test: `test/terminal.test.ts`

**Interfaces:**
- Consumes: F2 `AskUser`; E3b `AskHuman`; Foundation `PermissionRequest`; `node:readline/promises`.
- Produces:
  - `type LineReader = (prompt: string) => Promise<string>`
  - `makeAskUser(read): AskUser`, `makeApprove(read): (req) => Promise<boolean>`, `makeAskHuman(read): AskHuman`, `nodeLineReader(): LineReader`

- [ ] **Step 1: Kırmızı test**

`test/terminal.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { makeAskUser, makeApprove, makeAskHuman } from "../src/terminal.js";
import type { PermissionRequest } from "../src/permission/engine.js";
import type { Card } from "../src/board/board.js";

const req: PermissionRequest = { level: "write", preview: "write foo.txt", allowKey: "foo.txt" };
const card = { title: "X yap" } as Card;
const verdict = { verdict: "fail" as const, notes: ["n"] };

describe("makeAskUser", () => {
  it("soruyu okuyucuya iletir, cevabı döner", async () => {
    const au = makeAskUser(async (p) => { expect(p).toContain("X mi?"); return "cevap"; });
    expect(await au("X mi?")).toBe("cevap");
  });
});

describe("makeApprove", () => {
  it("e/evet/y/yes → true; diğer → false", async () => {
    expect(await makeApprove(async () => "e")(req)).toBe(true);
    expect(await makeApprove(async () => "evet")(req)).toBe(true);
    expect(await makeApprove(async () => "y")(req)).toBe(true);
    expect(await makeApprove(async () => "h")(req)).toBe(false);
    expect(await makeApprove(async () => "")(req)).toBe(false);
  });
});

describe("makeAskHuman", () => {
  it("accept / retry:<not> / abandon parse eder", async () => {
    expect(await makeAskHuman(async () => "accept")({ card, verdict })).toEqual({ action: "accept" });
    expect(await makeAskHuman(async () => "retry: düzelt")({ card, verdict })).toEqual({ action: "retry", notes: ["düzelt"] });
    expect(await makeAskHuman(async () => "xyz")({ card, verdict })).toEqual({ action: "abandon" });
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/terminal.test.ts`
Expected: FAIL — `terminal.js` yok.

- [ ] **Step 3: terminal.ts implement**

`src/terminal.ts` oluştur:

```typescript
import { createInterface } from "node:readline/promises";
import type { AskUser } from "./engine/review.js";
import type { AskHuman } from "./engine/escalation.js";
import type { PermissionRequest } from "./permission/engine.js";

export type LineReader = (prompt: string) => Promise<string>;

export function makeAskUser(read: LineReader): AskUser {
  return (question) => read(`\n[soru] ${question}\n> `);
}

export function makeApprove(read: LineReader): (req: PermissionRequest) => Promise<boolean> {
  return async (req) => {
    const ans = (await read(`\n[izin] ${req.preview}\nonayla? (e/h) > `)).trim().toLowerCase();
    return ans === "e" || ans === "evet" || ans === "y" || ans === "yes";
  };
}

export function makeAskHuman(read: LineReader): AskHuman {
  return async (ctx) => {
    const notes = ctx.verdict.notes.join("; ");
    const ans = (await read(`\n[insan] task "${ctx.card.title}" — ${notes}\n(accept / retry: <not> / abandon) > `)).trim();
    const low = ans.toLowerCase();
    if (low === "accept" || low === "kabul") return { action: "accept" };
    if (low.startsWith("retry")) {
      const note = ans.slice(ans.indexOf(":") + 1).trim();
      return { action: "retry", notes: note && ans.includes(":") ? [note] : [] };
    }
    return { action: "abandon" };
  };
}

/**
 * Üretim satır-okuyucusu (node:readline). `close()` çağrılmazsa stdin açık kalır ve süreç
 * asılı kalır → CLI iş bitince `close()` etmeli.
 */
export function nodeLineReader(): { read: LineReader; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { read: (prompt) => rl.question(prompt), close: () => rl.close() };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run: `npm run typecheck`

```bash
git add src/terminal.ts test/terminal.test.ts
git commit -m "feat: terminal seam'leri (makeAskUser/makeApprove/makeAskHuman + nodeLineReader)"
```

---

### Task 4: `src/cli.ts` — Giriş

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`
- Possibly: `tsup.config.ts` (build entry — yalnız gerekliyse)

**Interfaces:**
- Consumes: Task 1–3; Foundation `loadConfig`; B1 `OmniRouteProvider`; E-skills `SkillRegistry`; D `WorktreeManager`/`defaultGitRunner`/`toSlug`; H1 `runJob`/`JobResult`.
- Produces (saf, export'lu): `parseArgs(argv): CliArgs`, `renderResult(res: JobResult): string`; ayrıca `main(argv): Promise<void>` (ince glue).

- [ ] **Step 1: Kırmızı test**

`test/cli.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { parseArgs, renderResult } from "../src/cli.js";

describe("parseArgs", () => {
  it("prompt + flag'ler", () => {
    expect(parseArgs(["X ekle", "--branch", "dev", "--rounds", "2"])).toEqual({ prompt: "X ekle", fromBranch: "dev", rounds: 2 });
  });
  it("çok kelimeli prompt birleşir; kısa flag'ler", () => {
    expect(parseArgs(["merhaba", "dünya", "-b", "main", "-j", "isim"])).toEqual({ prompt: "merhaba dünya", fromBranch: "main", jobName: "isim" });
  });
});

describe("renderResult", () => {
  it("chat → response", () => {
    expect(renderResult({ kind: "chat", response: "cevap" })).toBe("cevap");
  });
  it("rejected → stage'i içerir", () => {
    expect(renderResult({ kind: "rejected", stage: "spec" })).toContain("spec");
  });
  it("done → rapor + PR url", () => {
    const out = renderResult({
      kind: "done", report: "rapor",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [] },
      session: {} as never,
    });
    expect(out).toContain("rapor");
    expect(out).toContain("http://pr");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `cli.js` yok.

- [ ] **Step 3: cli.ts implement**

`src/cli.ts` oluştur:

```typescript
#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/config.js";
import { OmniRouteProvider } from "./providers/omniroute.js";
import { SkillRegistry } from "./skills/registry.js";
import { WorktreeManager } from "./worktree/manager.js";
import { defaultGitRunner } from "./worktree/git.js";
import { toSlug } from "./worktree/slug.js";
import { buildJobDeps, logPRAdapter } from "./wiring.js";
import { makeAskUser, makeApprove, makeAskHuman, nodeLineReader } from "./terminal.js";
import { runJob } from "./engine/job.js";
import type { JobResult } from "./engine/job.js";

export interface CliArgs {
  prompt: string;
  fromBranch?: string;
  jobName?: string;
  rounds?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromBranch: string | undefined;
  let jobName: string | undefined;
  let rounds: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch" || a === "-b") fromBranch = argv[++i];
    else if (a === "--job" || a === "-j") jobName = argv[++i];
    else if (a === "--rounds") rounds = Number(argv[++i]);
    else rest.push(a);
  }
  return {
    prompt: rest.join(" "),
    ...(fromBranch !== undefined && { fromBranch }),
    ...(jobName !== undefined && { jobName }),
    ...(rounds !== undefined && { rounds }),
  };
}

export function renderResult(res: JobResult): string {
  if (res.kind === "chat") return res.response;
  if (res.kind === "rejected") return `Onaylanmadı (${res.stage} aşamasında durduruldu).`;
  const pr =
    res.wave.status === "completed"
      ? `PR: ${res.wave.pr.url}`
      : `Kısmi: ${res.wave.failed.length} başarısız, ${res.wave.skipped.length} atlandı`;
  return `${res.report}\n\nDurum: ${res.wave.status} — ${pr}`;
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    const r = await defaultGitRunner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const b = r.stdout.trim();
    return b && b !== "HEAD" ? b : "main";
  } catch {
    return "main";
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.prompt) {
    console.error('kullanım: hcode "<prompt>" [--branch b] [--job j] [--rounds n]');
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const config = loadConfig({
    cwd,
    home: process.env.HOME ?? "",
    env: process.env,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
  });
  const provider = new OmniRouteProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const skillRegistry = new SkillRegistry();
  const skillsDir = join(cwd, ".horsecode", "skills");
  if (existsSync(skillsDir)) await skillRegistry.loadFromDir(skillsDir);
  const manager = new WorktreeManager({ repoRoot: cwd });
  const { read, close } = nodeLineReader();
  try {
    const deps = buildJobDeps({
      config, provider, skillRegistry, manager,
      prAdapter: logPRAdapter((s) => console.log(s)),
      askHuman: makeAskHuman(read),
      approve: makeApprove(read),
      signal: new AbortController().signal,
    });
    const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
    const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
    const res = await runJob(deps, {
      prompt: args.prompt, fromBranch, jobName,
      askUser: makeAskUser(read), maxRounds: args.rounds ?? 3,
    });
    console.log(renderResult(res));
  } finally {
    close(); // stdin'i kapat → süreç asılı kalmasın
  }
}

// Yalnızca doğrudan çalıştırıldığında (bin) main'i koş; import (test) sırasında koşma.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("hata:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS (parseArgs + renderResult; main koşmaz).

- [ ] **Step 5: Build + tüm suite + typecheck**

Run: `npm run typecheck`
Run: `npm run build && ls dist/cli.js`
Expected: typecheck temiz; `dist/cli.js` üretilir. **Eğer tsup `dist/cli.js` üretmezse** (entry tanımsız), `tsup.config.ts` ekle: `import { defineConfig } from "tsup"; export default defineConfig({ entry: ["src/cli.ts"], format: ["esm"], target: "node20" });` ve tekrar dene.
Run: `npm test`
Expected: tüm testler yeşil.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts tsup.config.ts 2>/dev/null; git add src/cli.ts test/cli.test.ts
git commit -m "feat: hcode CLI (parseArgs/renderResult + main: config→provider→deps→runJob)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 prompts → Task 1; §3 wiring (buildJobDeps + logPRAdapter) → Task 2; §4 terminal seam'leri → Task 3; §5 cli (parseArgs/renderResult/main) → Task 4. Tümü karşılandı.
- **Type consistency:** `buildJobDeps` `JobDeps` (H1) döner — tüm alanlar; `REQUIRED_ROLES` prompts↔wiring paylaşılır; `renderResult` `JobResult` (H1) union'ını daraltır (completed→pr, partial→failed/skipped).
- **resolve out-of-box:** her REQUIRED_ROLES için `config.roles[r] ?? {models:[config.model]}` + `DEFAULT_PROMPTS` → resolve fırlatmaz (wiring testi doğrular).
- **main güvenliği:** `import.meta.url === argv[1]` guard'ı → test import'unda main koşmaz; sadece bin'de.
- **Testlenebilirlik:** saf birimler (prompts/buildJobDeps/seam'ler/parseArgs/renderResult) test edilir; gerçek I/O (`main`, `nodeLineReader`) manuel `hcode` ile.
