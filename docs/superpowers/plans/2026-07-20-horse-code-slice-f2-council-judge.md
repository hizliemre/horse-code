# Dilim F2 — Council + Judge Review Döngüsü Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yeniden kullanılabilir §6 review döngüsünü kurmak: config councilor'ları → paralel çok-mercekli `runCouncil` → `runJudge` (pass/revize/ask-human) → `runReviewLoop` (revise callback + askUser seam + maxRounds→son insan kararı).

**Architecture:** `config.ts`'e `council.councilors[]` eklenir. `src/engine/review.ts` (escalation `council.ts`'ten ayrı) `buildCouncilRegistry` + `runCouncil` + `runJudge` + `runReviewLoop`'ı barındırır; mevcut `runStructuredRole`/`readOnlyRegistry`/`RoleRegistry` yeniden kullanılır.

**Tech Stack:** TypeScript ESM, zod, vitest, içerik-tabanlı deterministik provider + gerçek tmp workdir.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; paralel councilor'lar için **içerik-tabanlı provider** (systemPrompt'a göre yanıt); gerçek tmp workdir + doküman dosyası.
- **Abort yutulmaz:** `runReviewLoop` try/catch içermez; `runCouncil`(`Promise.all`)/`runJudge`/`revise`/`askUser` throw'u propagate eder.
- **Councilor/judge salt-okunur:** `readOnlyRegistry` (read/grep/glob + skill) — write/edit/shell YOK.
- **Deps:** `ReviewDeps extends TaskCycleDeps { councilRegistry: RoleRegistry; councilors: CouncilorConfig[] }`.

---

### Task 1: Config — `council.councilors[]`

**Files:**
- Modify: `src/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Produces: `interface CouncilorConfig { name: string; perspective: string; models: string[] }`; `ResolvedConfig` kazanır `council?: { councilors: CouncilorConfig[] }`; `fileSchema` + merge council'ı taşır.

- [ ] **Step 1: Kırmızı test**

`test/config/config.test.ts`'e ekle (mevcut `describe("loadConfig", ...)` içine):

```typescript
  it("council.councilors parse edilir", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ council: { councilors: [{ name: "sec", perspective: "güvenlik", models: ["m1"] }] } })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.council?.councilors[0].name).toBe("sec");
    expect(cfg.council?.councilors[0].perspective).toBe("güvenlik");
    expect(cfg.council?.councilors[0].models).toEqual(["m1"]);
  });

  it("council yoksa undefined", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.council).toBeUndefined();
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL — `council` alanı yok.

- [ ] **Step 3: config.ts'i genişlet**

`CouncilorConfig` interface'ini `RoleConfig`'ten sonra ekle:

```typescript
export interface CouncilorConfig {
  name: string;
  perspective: string;
  models: string[];
}
```

`ResolvedConfig`'e alan ekle (mevcut `roles: ...` altına):

```typescript
  council?: { councilors: CouncilorConfig[] };
```

`fileSchema`'ya ekle (mevcut `roles: ...optional()` altına, `.object({...})` içinde):

```typescript
    council: z
      .object({
        councilors: z.array(
          z.object({ name: z.string(), perspective: z.string(), models: z.array(z.string()) }),
        ),
      })
      .optional(),
```

(Merge: mevcut `{...DEFAULT_CONFIG, ...global, ...projectSafe}` spread'i `council`'ı taşır —
projectSafe varsa ezer, yoksa global, yoksa undefined. Ek merge satırı gerekmez.)

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/config/config.test.ts`
Expected: PASS (mevcut + 2 yeni test).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: config council.councilors[] (name, perspective, models)"
```

---

### Task 2: `buildCouncilRegistry` + `runCouncil` + `runJudge` (review.ts)

**Files:**
- Create: `src/engine/review.ts`
- Test: `test/engine/review.test.ts`

**Interfaces:**
- Consumes: Task 1 `CouncilorConfig`; E-skills `RoleRegistry`; E0 `runStructuredRole`; C `RoleAgentOptions`; E3a `readOnlyRegistry`, `TaskCycleDeps`; zod.
- Produces:
  - `ReviewDeps`, `AskUser`, `Assessment`, `AssessmentSchema`, `JudgeDecision`, `JudgeSchema`, `ReviewOutcome` (tipler)
  - `buildCouncilRegistry(councilors: CouncilorConfig[]): RoleRegistry`
  - `runCouncil(deps: ReviewDeps, workdir: string, docPath: string): Promise<Assessment[]>`
  - `runJudge(deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[]): Promise<JudgeDecision>`

- [ ] **Step 1: Kırmızı test**

`test/engine/review.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCouncilRegistry, runCouncil, runJudge,
  type ReviewDeps,
} from "../../src/engine/review.js";
import type { CouncilorConfig } from "../../src/config/config.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-review-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// İçerik-tabanlı deterministik provider: councilor (systemPrompt "Perspektif") + judge ("P-judge").
export function reviewProvider(opts: { assessments?: Record<string, string>; judge?: string[] }): Provider {
  let judgeCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const emit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      if (sys.includes("Perspektif")) {
        const key = Object.keys(opts.assessments ?? {}).find((k) => sys.includes(k));
        yield* emit((opts.assessments ?? {})[key ?? ""] ?? '{"concerns":[],"recommendation":"approve"}');
        return;
      }
      if (sys.includes("P-judge")) {
        const arr = opts.judge ?? ['{"decision":"pass","feedback":[],"question":""}'];
        yield* emit(arr[judgeCall] ?? arr[arr.length - 1]);
        judgeCall++;
        return;
      }
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

export const councilors: CouncilorConfig[] = [
  { name: "security", perspective: "güvenlik açıkları", models: ["m"] },
  { name: "arch", perspective: "mimari katmanlar", models: ["m"] },
];

export function rdeps(provider: Provider, signal?: AbortSignal): ReviewDeps {
  const roles: Record<string, RoleConfig> = { judge: { models: ["m"], systemPrompt: "P-judge" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    councilRegistry: buildCouncilRegistry(councilors),
    councilors,
  };
}

describe("buildCouncilRegistry", () => {
  it("councilor'ı role'e çevirir; resolve model + perspektif prompt döner", () => {
    const reg = buildCouncilRegistry(councilors);
    const r = reg.resolve("security");
    expect(r.model).toBe("m");
    expect(r.systemPrompt).toContain("güvenlik açıkları");
  });
});

describe("runCouncil", () => {
  it("councilor'ları paralel koşar → isimli assessment'lar; salt-okunur toolset", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: {
        "güvenlik": '{"concerns":["secret sızıntısı"],"recommendation":"revise"}',
        "mimari": '{"concerns":[],"recommendation":"approve"}',
      },
    });
    const out = await runCouncil(rdeps(p), dir, "spec.md");
    const byName = Object.fromEntries(out.map((a) => [a.name, a]));
    expect(byName.security.recommendation).toBe("revise");
    expect(byName.security.concerns).toEqual(["secret sızıntısı"]);
    expect(byName.arch.recommendation).toBe("approve");
  });
});

describe("runJudge", () => {
  it("assessments + judge → karar", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["testsiz"],"question":""}'] });
    const d = await runJudge(rdeps(p), dir, "spec.md", [
      { name: "security", concerns: ["x"], recommendation: "revise" },
    ]);
    expect(d.decision).toBe("revise");
    expect(d.feedback).toEqual(["testsiz"]);
  });
});
```

> **Not (toolset assertion):** `reviewProvider` istekleri yakalamaz. Salt-okunur toolset kontrolü
> için `runCouncil` testinde `reviewProvider` yerine tek-councilor + `MockProvider` kullanıp
> `p.requests[0].tools`'u doğrula (aşağıdaki ek test). Implementer bu ek testi ekler:

```typescript
  it("councilor toolset salt-okunur (read/grep/glob/skill; write/shell yok)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const { MockProvider } = await import("../../src/providers/mock.js");
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"concerns":[],"recommendation":"approve"}' } },
       { type: "done", finishReason: "tool_calls" }],
    ]);
    const one: CouncilorConfig[] = [{ name: "solo", perspective: "genel", models: ["m"] }];
    const deps: ReviewDeps = { ...rdeps(p), councilRegistry: buildCouncilRegistry(one), councilors: one };
    await runCouncil(deps, dir, "spec.md");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });
```

(Bu ek testi `describe("runCouncil", ...)` içine koy; ilk `runCouncil` testindeki yorum-satırı
toolset kısmını kaldır — assertion bu ek testtedir.)

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/review.test.ts`
Expected: FAIL — `review.js` yok.

- [ ] **Step 3: review.ts implement**

`src/engine/review.ts` oluştur:

```typescript
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { CouncilorConfig, RoleConfig } from "../config/config.js";

export interface ReviewDeps extends TaskCycleDeps {
  councilRegistry: RoleRegistry;
  councilors: CouncilorConfig[];
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
  question: z.string(),
});

export interface ReviewOutcome { approved: boolean }

function councilPrompt(perspective: string): string {
  return (
    `Sen bir review council üyesisin. Perspektifin: ${perspective}. ` +
    `Verilen dokümanı bu perspektiften incele; gerekçeli concerns listesi ve öneri (approve/revise) üret.`
  );
}

/** Councilor'ları round-robin bir RoleRegistry'ye çevirir (name → perspektif prompt'lu role). */
export function buildCouncilRegistry(councilors: CouncilorConfig[]): RoleRegistry {
  const roles: Record<string, RoleConfig> = {};
  for (const c of councilors) roles[c.name] = { models: c.models, systemPrompt: councilPrompt(c.perspective) };
  return new RoleRegistry(roles);
}

/** Councilor'ları paralel koşar; her biri dokümanı salt-okunur inceleyip isimli assessment üretir. */
export async function runCouncil(deps: ReviewDeps, workdir: string, docPath: string): Promise<Assessment[]> {
  return Promise.all(
    deps.councilors.map(async (c) => {
      const { model, systemPrompt } = deps.councilRegistry.resolve(c.name);
      const opts: RoleAgentOptions = {
        provider: deps.provider, model, systemPrompt,
        tools: readOnlyRegistry(deps),
        messages: [{ role: "user", content: `"${docPath}" dokümanını incele ve bu perspektiften değerlendir.` }],
        permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
      };
      const r = await runStructuredRole(opts, AssessmentSchema);
      return { name: c.name, concerns: r.concerns, recommendation: r.recommendation };
    }),
  );
}

/** Judge council değerlendirmelerini sentezleyip tek karar verir (pass/revize/ask-human). */
export async function runJudge(
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[],
): Promise<JudgeDecision> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("judge");
  const summary = assessments.map((a) => `- ${a.name} (${a.recommendation}): ${a.concerns.join("; ")}`).join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `"${docPath}" dokümanı ve council değerlendirmeleri:\n${summary}\nSentezle ve karar ver.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  return runStructuredRole(opts, JudgeSchema);
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/review.ts test/engine/review.test.ts
git commit -m "feat: buildCouncilRegistry + runCouncil (paralel) + runJudge"
```

---

### Task 3: `runReviewLoop`

**Files:**
- Modify: `src/engine/review.ts` (runReviewLoop ekle)
- Modify: `test/engine/review.test.ts` (runReviewLoop testleri)

**Interfaces:**
- Consumes: Task 2 `runCouncil`, `runJudge`, `ReviewDeps`, `AskUser`, `ReviewOutcome`.
- Produces: `runReviewLoop(deps: ReviewDeps, workdir: string, docPath: string, revise: (feedback: string[]) => Promise<void>, askUser: AskUser, maxRounds: number): Promise<ReviewOutcome>`

- [ ] **Step 1: Kırmızı test**

`test/engine/review.test.ts`'e ekle. **`runReviewLoop`'u üstteki mevcut
`from "../../src/engine/review.js"` import bloğuna ekle** (ayrı satır değil), sonra describe'ı sona ekle:

```typescript
// (üstteki import'a runReviewLoop eklendi)

describe("runReviewLoop", () => {
  const noRevise = async () => {};

  it("pass ilk turda → approved, revise çağrılmaz", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("revize → revise(feedback) → ikinci tur pass → approved", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["testsiz"],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(feedbacks).toEqual([["testsiz"]]);
  });

  it("ask-human → askUser çağrılır, cevap sonraki revise feedback'inde → pass", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"ask-human","feedback":["belirsiz"],"question":"X mi Y mi?"}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    let asked = "";
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async (q) => { asked = q; return "X"; }, 3);
    expect(out.approved).toBe(true);
    expect(asked).toBe("X mi Y mi?");
    expect(feedbacks[0].some((s) => s.includes("X"))).toBe(true);
  });

  it("maxRounds tükendi → son askUser 'onayla' → approved; 'durdur' → değil", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p1 = reviewProvider({ judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const ok = await runReviewLoop(rdeps(p1), dir, "spec.md", noRevise, async () => "onayla", 2);
    expect(ok.approved).toBe(true);
    const p2 = reviewProvider({ judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const stop = await runReviewLoop(rdeps(p2), dir, "spec.md", noRevise, async () => "durdur", 2);
    expect(stop.approved).toBe(false);
  });

  it("iptal edilmişse fırlatır", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const ac = new AbortController(); ac.abort();
    const p = reviewProvider({});
    await expect(
      runReviewLoop(rdeps(p, ac.signal), dir, "spec.md", noRevise, async () => "x", 2),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/review.test.ts`
Expected: FAIL — `runReviewLoop` yok.

- [ ] **Step 3: runReviewLoop implement**

`src/engine/review.ts` sonuna ekle:

```typescript
/**
 * §6 review döngüsü: council → judge; pass→onaylı, revize→revise(feedback)→tekrar,
 * ask-human→askUser→feedback→revise→tekrar. maxRounds tükenince son insan kararı (onayla/durdur).
 */
export async function runReviewLoop(
  deps: ReviewDeps,
  workdir: string,
  docPath: string,
  revise: (feedback: string[]) => Promise<void>,
  askUser: AskUser,
  maxRounds: number,
): Promise<ReviewOutcome> {
  for (let round = 0; round < maxRounds; round++) {
    const assessments = await runCouncil(deps, workdir, docPath);
    const d = await runJudge(deps, workdir, docPath, assessments);
    if (d.decision === "pass") return { approved: true };
    let feedback = d.feedback;
    if (d.decision === "ask-human") {
      const answer = await askUser(d.question);
      feedback = [...feedback, `İnsan cevabı: ${answer}`];
    }
    await revise(feedback);
  }
  const answer = await askUser(`${maxRounds} revize turunda onaylanmadı. Onayla / durdur?`);
  return { approved: /onayla|approve|evet|yes/i.test(answer) };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/review.ts test/engine/review.test.ts
git commit -m "feat: runReviewLoop (council→judge; revise/ask-human/maxRounds→son insan kararı)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 config council → Task 1; §4.1 buildCouncilRegistry + §4.2 runCouncil + §4.3 runJudge → Task 2; §4.4 runReviewLoop → Task 3; §5 testler (içerik-provider, salt-okunur, loop dalları) → her üç task. Tümü karşılandı.
- **Type consistency:** `AssessmentSchema`/`JudgeSchema` zod tipleri `Assessment`/`JudgeDecision`'la eşleşir; `ReviewDeps extends TaskCycleDeps` + councilRegistry/councilors; `runReviewLoop` `ReviewOutcome` döner.
- **Determinizm:** councilor'lar içerik-provider ile keyed (paralel-safe); judge counter ile sıralı kararlar; team-lead yok.
- **Abort:** loop try/catch'siz → runCouncil(Promise.all)/runJudge throw'u propagate; pre-aborted testi doğrular.
