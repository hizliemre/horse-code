# Dilim F3 — Analyst + Planner + Upstream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F'yi tamamlamak: `buildAskUserTool` + `runAnalyst` (ask_user'lı spec yazımı) + `runPlanner` (plan yazımı) + `runUpstream` (refiner→route→chat|analyst-spec-loop→planner-plan-loop → onaylı `{intent, specPath, planPath}`).

**Architecture:** `src/engine/upstream.ts` F1 (refiner/coach) + F2 (review loop) + B2 tool'ları birleştirir. Analyst/planner `runToCompletion` ile dosya yazar; `runUpstream` zinciri F2 `runReviewLoop`'u `revise` callback'iyle kullanır.

**Tech Stack:** TypeScript ESM, zod, vitest, içerik-tabanlı deterministik provider + gerçek tmp workdir.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; içerik-tabanlı provider (systemPrompt + tool-mesajlarına göre yanıt); gerçek tmp workdir.
- **Abort yutulmaz:** `runUpstream` try/catch içermez; alt birimler throw'u propagate eder.
- **Analyst/planner shell/web'siz:** `writerRegistry` = read/write/edit/grep/glob + skill (+ analyst'te ask_user).
- **Deps:** `ReviewDeps` (F2) reuse — refiner/coach/analyst/planner/judge roleRegistry'de, council councilRegistry'de.

---

### Task 1: `buildAskUserTool` + `writerRegistry` + `runAnalyst`

**Files:**
- Create: `src/engine/upstream.ts`
- Test: `test/engine/upstream.test.ts`

**Interfaces:**
- Consumes: F2 `ReviewDeps`, `AskUser`; C `runToCompletion`/`RoleAgentOptions`; B2 tool'lar + `ToolRegistry`; E-skills `buildSkillTool`; core `Tool`/`ToolContext`; zod.
- Produces:
  - `buildAskUserTool(askUser: AskUser): Tool`
  - `runAnalyst(deps: ReviewDeps, workdir: string, specPath: string, prompt: string, feedback: string[] | undefined, askUser: AskUser): Promise<void>`
  - (dahili) `writerRegistry`

- [ ] **Step 1: Kırmızı test**

`test/engine/upstream.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAskUserTool, runAnalyst } from "../../src/engine/upstream.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import { buildCouncilRegistry } from "../../src/engine/review.js";
import type { CouncilorConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider, ChatRequest, ToolContext } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-upstream-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal });

// İçerik-tabanlı provider: systemPrompt (rol) + tool-mesajlarına göre yanıt; requests yakalar.
export function upstreamProvider(opts: { intent?: string; judge?: string[]; analystAsk?: string } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const submit = function* (a: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const call = function* (name: string, a: string) {
        yield { type: "tool-call", toolCall: { id: "t", name, arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const stop = function* (t: string) {
        yield { type: "text-delta", text: t } as const;
        yield { type: "done", finishReason: "stop" } as const;
      };
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"X yap","intent":"${opts.intent ?? "feature"}"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach cevabı"); return; }
      if (sys.includes("P-analyst")) {
        if (opts.analystAsk && toolMsgs.length === 0) { yield* call("ask_user", JSON.stringify({ question: opts.analystAsk })); return; }
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "spec.md", content: "# spec" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("P-planner")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "plan.md", content: "# plan" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("Perspektif")) { yield* submit('{"concerns":[],"recommendation":"approve"}'); return; }
      if (sys.includes("P-judge")) {
        const arr = opts.judge ?? ['{"decision":"pass","feedback":[],"question":""}'];
        yield* submit(arr[judgeCall] ?? arr[arr.length - 1]);
        judgeCall++;
        return;
      }
      yield* stop("ok");
    },
  };
}

export function udeps(provider: Provider, signal?: AbortSignal): ReviewDeps {
  const roles: Record<string, RoleConfig> = {
    refiner: { models: ["m"], systemPrompt: "P-refiner" },
    coach: { models: ["m"], systemPrompt: "P-coach" },
    analyst: { models: ["m"], systemPrompt: "P-analyst" },
    planner: { models: ["m"], systemPrompt: "P-planner" },
    judge: { models: ["m"], systemPrompt: "P-judge" },
  };
  const councilors: CouncilorConfig[] = [{ name: "sec", perspective: "güvenlik", models: ["m"] }];
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

describe("buildAskUserTool", () => {
  it("askUser'ı çağırır, cevabı content'te döner", async () => {
    let asked = "";
    const t = buildAskUserTool(async (q) => { asked = q; return "cevabım"; });
    const res = await t.run({ question: "X mi?" }, ctx());
    expect(asked).toBe("X mi?");
    expect(res.content).toBe("cevabım");
    expect(res.isError).toBe(false);
  });

  it("geçersiz args → isError", async () => {
    const t = buildAskUserTool(async () => "x");
    const res = await t.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

describe("runAnalyst", () => {
  it("spec dosyasını yazar; toolset ask_user+write içerir, shell yok", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", undefined, async () => "x");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_user", "write_file", "read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("shell");
    expect(names).not.toContain("web_fetch");
  });

  it("feedback doluysa istekte notlar geçer (revize)", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", ["testsiz kalmış"], async () => "x");
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("testsiz kalmış");
  });

  it("analyst ask_user çağırırsa askUser tetiklenir", async () => {
    const p = upstreamProvider({ analystAsk: "X mi Y mi?" });
    let asked = "";
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", undefined, async (q) => { asked = q; return "X"; });
    expect(asked).toBe("X mi Y mi?");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: FAIL — `upstream.js` yok.

- [ ] **Step 3: upstream.ts implement (buildAskUserTool + writerRegistry + runAnalyst)**

`src/engine/upstream.ts` oluştur:

```typescript
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { ReviewDeps, AskUser } from "./review.js";

const askUserParams = z.object({ question: z.string() });

/** Analyst'in kullanıcıya soru sorması için tool (buildSkillTool paterni); cevabı content'te döner. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description: "Kullanıcıya bir soru sor ve cevabını al.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const answer = await askUser(parsed.data.question);
      return { content: answer, isError: false };
    },
  };
}

/** Dosya-yazan rollerin toolset'i: read/write/edit/grep/glob + skill (+ extra); shell/web YOK. */
function writerRegistry(deps: ReviewDeps, extra: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  for (const t of extra) r.register(t);
  return r;
}

/** Analyst: ask_user ile soru sorup spec dosyasını yazar (revize'de feedback ile). */
export async function runAnalyst(
  deps: ReviewDeps,
  workdir: string,
  specPath: string,
  prompt: string,
  feedback: string[] | undefined,
  askUser: AskUser,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("analyst");
  const tools = writerRegistry(deps, [buildAskUserTool(askUser)]);
  const content =
    feedback && feedback.length
      ? `"${specPath}" spec'ini şu reviewer notlarıyla revize et:\n${feedback.map((f) => `- ${f}`).join("\n")}\nOrijinal istek: ${prompt}`
      : `İstek: "${prompt}". Gerekirse ask_user ile kullanıcıya sor; spec dosyasını "${specPath}"'e write_file ile yaz.`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  await runToCompletion(opts);
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/upstream.ts test/engine/upstream.test.ts
git commit -m "feat: buildAskUserTool + runAnalyst (ask_user'lı spec yazımı)"
```

---

### Task 2: `runPlanner`

**Files:**
- Modify: `src/engine/upstream.ts` (runPlanner ekle)
- Modify: `test/engine/upstream.test.ts` (runPlanner testleri)

**Interfaces:**
- Consumes: Task 1 `writerRegistry`, `ReviewDeps`; C `runToCompletion`.
- Produces: `runPlanner(deps: ReviewDeps, workdir: string, planPath: string, specPath: string, feedback: string[] | undefined): Promise<void>`

- [ ] **Step 1: Kırmızı test**

`test/engine/upstream.test.ts`'e ekle (`runPlanner`'ı üstteki `from "../../src/engine/upstream.js"` import'una ekle):

```typescript
describe("runPlanner", () => {
  it("plan dosyasını yazar; toolset write var, ask_user yok", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", undefined);
    expect(await readFile(join(dir, "plan.md"), "utf8")).toBe("# plan");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).not.toContain("ask_user");
  });

  it("feedback doluysa istekte notlar geçer", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", ["dalga eksik"]);
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("dalga eksik");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: FAIL — `runPlanner` yok.

- [ ] **Step 3: runPlanner implement**

`src/engine/upstream.ts` sonuna ekle:

```typescript
/** Planner: spec'i okuyup plan dosyasını yazar (revize'de feedback ile). ask_user YOK — soru sormaz. */
export async function runPlanner(
  deps: ReviewDeps,
  workdir: string,
  planPath: string,
  specPath: string,
  feedback: string[] | undefined,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("planner");
  const tools = writerRegistry(deps);
  const content =
    feedback && feedback.length
      ? `"${planPath}" plan'ını şu reviewer notlarıyla revize et:\n${feedback.map((f) => `- ${f}`).join("\n")}\n("${specPath}" spec'inden)`
      : `"${specPath}" spec'ini oku ve plan'ı "${planPath}"'e write_file ile yaz.`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  await runToCompletion(opts);
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/upstream.ts test/engine/upstream.test.ts
git commit -m "feat: runPlanner (spec→plan yazımı, ask_user'sız)"
```

---

### Task 3: `runUpstream`

**Files:**
- Modify: `src/engine/upstream.ts` (runUpstream + UpstreamResult ekle)
- Modify: `test/engine/upstream.test.ts` (runUpstream testleri)

**Interfaces:**
- Consumes: Task 1/2 `runAnalyst`/`runPlanner`; F1 `runRefiner`/`routeIntent`/`Intent`/`runCoachChat`; F2 `runReviewLoop`/`AskUser`.
- Produces:
  - `type UpstreamResult = { intent: Intent; kind: "chat"; response: string } | { intent: Intent; kind: "approved"; specPath: string; planPath: string } | { intent: Intent; kind: "rejected"; stage: "spec" | "plan" }`
  - `runUpstream(deps: ReviewDeps, workdir: string, prompt: string, askUser: AskUser, maxRounds: number): Promise<UpstreamResult>`

- [ ] **Step 1: Kırmızı test**

`test/engine/upstream.test.ts`'e ekle (`runUpstream`'ı üstteki import'a ekle):

```typescript
describe("runUpstream", () => {
  it("chat intent → coach cevabı", async () => {
    const p = upstreamProvider({ intent: "chat" });
    const res = await runUpstream(udeps(p), dir, "merhaba", async () => "x", 3);
    expect(res.kind).toBe("chat");
    if (res.kind === "chat") expect(res.response).toBe("coach cevabı");
    expect(res.intent).toBe("chat");
  });

  it("feature → spec+plan onaylanır → approved, iki dosya yazılı", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "X ekle", async () => "x", 3);
    expect(res.kind).toBe("approved");
    if (res.kind === "approved") {
      expect(res.specPath).toBe("spec.md");
      expect(res.planPath).toBe("plan.md");
    }
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
    expect(await readFile(join(dir, "plan.md"), "utf8")).toBe("# plan");
  });

  it("spec onaylanmazsa → rejected(spec)", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "X ekle", async () => "durdur", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("spec");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController(); ac.abort();
    const p = upstreamProvider({ intent: "feature" });
    await expect(runUpstream(udeps(p, ac.signal), dir, "X", async () => "x", 2)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: FAIL — `runUpstream` yok.

- [ ] **Step 3: runUpstream implement**

`src/engine/upstream.ts`'e import'ları ekle (üstteki import bloğuna):

```typescript
import { runRefiner, routeIntent, type Intent } from "./refiner.js";
import { runCoachChat } from "./coach.js";
import { runReviewLoop } from "./review.js";
```

Dosya sonuna ekle:

```typescript
export type UpstreamResult =
  | { intent: Intent; kind: "chat"; response: string }
  | { intent: Intent; kind: "approved"; specPath: string; planPath: string }
  | { intent: Intent; kind: "rejected"; stage: "spec" | "plan" };

/**
 * Upstream pipeline: refiner → route; chat→coach cevabı; pipeline→analyst spec (F2 review) →
 * planner plan (F2 review) → onaylı {specPath, planPath}; reddedilirse {rejected, stage}.
 */
export async function runUpstream(
  deps: ReviewDeps,
  workdir: string,
  prompt: string,
  askUser: AskUser,
  maxRounds: number,
): Promise<UpstreamResult> {
  const r = await runRefiner(deps, prompt);
  if (routeIntent(r.intent) === "chat") {
    const response = await runCoachChat(deps, r.refinedPrompt, workdir);
    return { intent: r.intent, kind: "chat", response };
  }

  const specPath = "spec.md";
  await runAnalyst(deps, workdir, specPath, r.refinedPrompt, undefined, askUser);
  const specOut = await runReviewLoop(
    deps, workdir, specPath,
    (fb) => runAnalyst(deps, workdir, specPath, r.refinedPrompt, fb, askUser),
    askUser, maxRounds,
  );
  if (!specOut.approved) return { intent: r.intent, kind: "rejected", stage: "spec" };

  const planPath = "plan.md";
  await runPlanner(deps, workdir, planPath, specPath, undefined);
  const planOut = await runReviewLoop(
    deps, workdir, planPath,
    (fb) => runPlanner(deps, workdir, planPath, specPath, fb),
    askUser, maxRounds,
  );
  if (!planOut.approved) return { intent: r.intent, kind: "rejected", stage: "plan" };

  return { intent: r.intent, kind: "approved", specPath, planPath };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/upstream.test.ts`
Expected: PASS.

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/upstream.ts test/engine/upstream.test.ts
git commit -m "feat: runUpstream (refiner→route→chat|analyst-spec→planner-plan→onaylı)"
```

---

## Self-Review Notu

- **Spec coverage:** §3.1 buildAskUserTool + §3.2 writerRegistry + §3.3 runAnalyst → Task 1; §3.4 runPlanner → Task 2; §3.5 runUpstream + UpstreamResult → Task 3; §4 testler → her üç task. Tümü karşılandı.
- **Type consistency:** `ReviewDeps` (F2) reuse; `UpstreamResult` discriminated union (`kind`); `Intent` (F1); analyst/planner `void` döner (dosya side-effect).
- **Determinizm:** içerik-provider systemPrompt (rol) + tool-mesajlarına (write_file/ask_user) göre keyed; judge counter iki review-loop boyunca sıralı; paralel council keyed.
- **Abort:** runUpstream try/catch'siz → refiner/analyst/reviewLoop/planner throw'u propagate; pre-aborted testi doğrular.
