# Dilim G1 — Revision Pipeline (Mantık) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapter-agnostik revision döngüsü: principal-coder PR review → değişiklikte senior-coder ana worktree'de düzeltir → re-review; ≤N tur, son turda principal son karar (accept | insana sor).

**Architecture:** `src/prompts.ts`'e principal-coder rolü eklenir. `src/engine/revision.ts` `runRevision`'ı barındırır (principalReview/principalFinal structured + seniorRevise). Seam'ler (`postComments`/`askUser`) enjekte; gerçek gh/az + runJob wiring → G2.

**Tech Stack:** TypeScript ESM, zod, vitest, içerik-tabanlı provider + gerçek tmp base worktree + fake manager.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; içerik-tabanlı provider (principal review vs final, senior); gerçek tmp base worktree (senior gerçek dosya yazar) + fake manager (commitMerge/push kaydeder) + fake seam'ler.
- **Abort yutulmaz:** `runRevision` try/catch içermez; alt katman throw'u propagate eder.
- **senior ana worktree'de:** izole worktree AÇMAZ; `cwd = session.baseWorktree`, tam tool'lar.
- **Adapter-agnostik:** `postComments`/`askUser` enjekte seam; G1 gerçek gh/az bilmez.

---

### Task 1: `prompts.ts` — principal-coder rolü

**Files:**
- Modify: `src/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Produces: `REQUIRED_ROLES`'e `"principal-coder"` eklenir; `DEFAULT_PROMPTS["principal-coder"]` işlevsel prompt. (H2 wiring zaten config.model + DEFAULT_PROMPTS ile çözer.)

- [ ] **Step 1: Kırmızı test**

`test/prompts.test.ts`'e ekle (`import`'a REQUIRED_ROLES/DEFAULT_PROMPTS zaten var):

```typescript
  it("principal-coder rolü tanımlı (G1)", () => {
    expect(REQUIRED_ROLES).toContain("principal-coder");
    expect(DEFAULT_PROMPTS["principal-coder"]).toBeDefined();
    expect(DEFAULT_PROMPTS["principal-coder"].length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — principal-coder yok.

- [ ] **Step 3: prompts.ts'e principal-coder ekle**

`REQUIRED_ROLES` dizisine `"principal-coder"` ekle (sona):

```typescript
export const REQUIRED_ROLES = [
  "refiner", "coach", "analyst", "planner", "judge", "project-manager", "team-lead",
  "router", "coder", "designer", "senior-coder", "senior-designer", "architect", "code-reviewer",
  "principal-coder",
] as const;
```

`DEFAULT_PROMPTS`'a ekle (code-reviewer'dan sonra):

```typescript
  "principal-coder":
    "PR'daki tüm değişiklikleri (base worktree) bütünsel review et. Yeterliyse approve; değilse request-changes ve somut comment'ler ver. Son karar turunda accept (kabul) veya ask-human (kullanıcıya sorulacak soru) ver.",
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run: `npm run typecheck`

```bash
git add src/prompts.ts test/prompts.test.ts
git commit -m "feat: principal-coder rolü + varsayılan prompt (G1)"
```

---

### Task 2: `src/engine/revision.ts` — `runRevision`

**Files:**
- Create: `src/engine/revision.ts`
- Test: `test/engine/revision.test.ts`

**Interfaces:**
- Consumes: E0 `runStructuredRole`; C `runToCompletion`/`RoleAgentOptions`; E3a `readOnlyRegistry`/`TaskCycleDeps`; B2 `createDefaultRegistry`; E-skills `buildSkillTool`; D `WorktreeManager`/`WorktreeSession`; E1 `Board`; F2 `AskUser`; zod.
- Produces:
  - `RevisionDeps` (`TaskCycleDeps & { manager: Pick<WorktreeManager, "commitMerge" | "push"> }`)
  - `PostComments`, `PrincipalReviewSchema`, `PrincipalFinalSchema`, `RevisionResult`
  - `runRevision(deps, session, board, postComments, askUser, maxRounds): Promise<RevisionResult>`

- [ ] **Step 1: Kırmızı test**

`test/engine/revision.test.ts` oluştur:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRevision, type RevisionDeps } from "../../src/engine/revision.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";
import { Board } from "../../src/board/board.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-rev-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// principal (review vs "SON KARAR" final) + senior (write→done) içerik-provider.
function revisionProvider(opts: { reviews: string[]; final?: string }): Provider {
  let reviewCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
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
      if (sys.includes("P-principal")) {
        if (convo.includes("SON KARAR")) { yield* submit(opts.final ?? '{"decision":"accept","question":""}'); return; }
        yield* submit(opts.reviews[reviewCall] ?? opts.reviews[opts.reviews.length - 1]);
        reviewCall++;
        return;
      }
      if (sys.includes("P-senior-coder")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "fix.txt", content: "düzeltme" })); return; }
        yield* stop("bitti"); return;
      }
      yield* stop("ok");
    },
  };
}

function fakeManager() {
  return { commits: 0, pushes: 0, async commitMerge() { this.commits++; }, async push() { this.pushes++; } };
}

function rdeps(provider: Provider, manager: RevisionDeps["manager"], signal?: AbortSignal): RevisionDeps {
  const roles: Record<string, RoleConfig> = {
    "principal-coder": { models: ["m"], systemPrompt: "P-principal" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    manager,
  };
}

const session = (d: string): WorktreeSession => ({ jobSlug: "j", root: "/x", baseWorktree: d, baseBranch: "hc/j/base" });

describe("runRevision", () => {
  it("onay ilk turda → approved(0); senior/postComments/commit çağrılmaz", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const mgr = fakeManager();
    let posted = 0;
    const board = new Board();
    const res = await runRevision(rdeps(p, mgr), session(dir), board, async () => { posted++; }, async () => "x", 3);
    expect(res.status).toBe("approved");
    if (res.status === "approved") expect(res.rounds).toBe(0);
    expect(posted).toBe(0);
    expect(mgr.commits).toBe(0);
    expect(board.get("revision")!.stageHistory.some((s) => s.action === "pr:approved")).toBe(true);
  });

  it("bir revizyon → onay: postComments + senior yazar + commit/push; approved(1)", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["testsiz"]}', '{"decision":"approve","comments":[]}'] });
    const mgr = fakeManager();
    const posted: string[][] = [];
    const res = await runRevision(rdeps(p, mgr), session(dir), new Board(), async (c) => { posted.push(c); }, async () => "x", 3);
    expect(res.status).toBe("approved");
    if (res.status === "approved") expect(res.rounds).toBe(1);
    expect(posted).toEqual([["testsiz"]]);
    expect(mgr.commits).toBe(1);
    expect(mgr.pushes).toBe(1);
    expect(existsSync(join(dir, "fix.txt"))).toBe(true);
  });

  it("maxRounds → accept: son karar kabul", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["a"]}'], final: '{"decision":"accept","question":""}' });
    const mgr = fakeManager();
    const res = await runRevision(rdeps(p, mgr), session(dir), new Board(), async () => {}, async () => "x", 2);
    expect(res.status).toBe("accepted");
    if (res.status === "accepted") expect(res.rounds).toBe(2);
    expect(mgr.commits).toBe(1); // yalnız round1'de revize (round2 son karar)
  });

  it("maxRounds → insana sor: askUser çağrılır, cevap döner", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["a"]}'], final: '{"decision":"ask-human","question":"X mi Y mi?"}' });
    let asked = "";
    const res = await runRevision(rdeps(p, fakeManager()), session(dir), new Board(), async () => {}, async (q) => { asked = q; return "tamam"; }, 1);
    expect(res.status).toBe("human");
    if (res.status === "human") { expect(res.answer).toBe("tamam"); expect(res.rounds).toBe(1); }
    expect(asked).toBe("X mi Y mi?");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController(); ac.abort();
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    await expect(
      runRevision(rdeps(p, fakeManager(), ac.signal), session(dir), new Board(), async () => {}, async () => "x", 3),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/revision.test.ts`
Expected: FAIL — `revision.js` yok.

- [ ] **Step 3: revision.ts implement**

`src/engine/revision.ts` oluştur:

```typescript
import { z } from "zod";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { AskUser } from "./review.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry } from "./reviewer.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";

export interface RevisionDeps extends TaskCycleDeps {
  manager: Pick<WorktreeManager, "commitMerge" | "push">;
}
export type PostComments = (comments: string[]) => Promise<void>;

export const PrincipalReviewSchema = z.object({
  decision: z.enum(["approve", "request-changes"]),
  comments: z.array(z.string()),
});
export const PrincipalFinalSchema = z.object({
  decision: z.enum(["accept", "ask-human"]),
  question: z.string(),
});

export type RevisionResult =
  | { status: "approved"; rounds: number }
  | { status: "accepted"; rounds: number }
  | { status: "human"; rounds: number; answer: string };

async function principalReview(deps: RevisionDeps, base: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: "PR review: base worktree'deki tüm değişiklikleri bütünsel incele. approve veya request-changes + somut comment'ler ver." }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalReviewSchema);
}

async function principalFinal(deps: RevisionDeps, base: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: "SON KARAR: Revizyon turları bitti, hâlâ bulgu var. accept (kabul) veya ask-human (kullanıcıya sorulacak soru) ver." }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalFinalSchema);
}

async function seniorRevise(deps: RevisionDeps, base: string, comments: string[]): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("senior-coder");
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content: `PR revizyonu: şu yorumları gider (fix et veya "by design" gerekçele), ana worktree'de çalış:\n${comments.map((c) => `- ${c}`).join("\n")}` }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  await runToCompletion(opts);
}

/**
 * Revision döngüsü: principal review → approve:biter / request-changes: postComments + senior
 * düzeltir + commit/push → re-review. ≤maxRounds; son turda hâlâ bulgu → principal son karar.
 */
export async function runRevision(
  deps: RevisionDeps,
  session: WorktreeSession,
  board: Board,
  postComments: PostComments,
  askUser: AskUser,
  maxRounds: number,
): Promise<RevisionResult> {
  board.addCard({ id: "revision", title: "PR revision" });
  const base = session.baseWorktree;
  const rounds = Math.max(1, maxRounds);

  for (let round = 1; round <= rounds; round++) {
    const v = await principalReview(deps, base);
    if (v.decision === "approve") {
      board.appendStage("revision", { role: "principal-coder", action: "pr:approved" });
      return { status: "approved", rounds: round - 1 };
    }
    board.appendStage("revision", { role: "principal-coder", action: "pr:changes", note: v.comments.join("; ") });

    if (round === rounds) {
      const f = await principalFinal(deps, base);
      if (f.decision === "accept") {
        board.appendStage("revision", { role: "principal-coder", action: "pr:final:accept" });
        return { status: "accepted", rounds };
      }
      const answer = await askUser(f.question);
      board.appendStage("revision", { role: "human", action: "pr:human", note: answer });
      return { status: "human", rounds, answer };
    }

    await postComments(v.comments);
    await seniorRevise(deps, base, v.comments);
    board.appendStage("revision", { role: "senior-coder", action: "pr:revised" });
    await deps.manager.commitMerge(session, `hc: revision ${round}`);
    await deps.manager.push(session);
  }
  // erişilmez (rounds ≥ 1 → son iterasyon her zaman döner); tip güvenliği:
  return { status: "accepted", rounds };
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/revision.test.ts`
Expected: PASS (5 test).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/engine/revision.ts test/engine/revision.test.ts
git commit -m "feat: runRevision (principal review + senior revise + ≤N tur + son karar)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 principal-coder rolü → Task 1; §3 tipler + §4 runRevision (principalReview/Final/seniorRevise, döngü, son karar) → Task 2; §5 testler → her iki task. Tümü karşılandı.
- **Type consistency:** `RevisionDeps` (TaskCycleDeps + manager Pick); `PrincipalReviewSchema`/`PrincipalFinalSchema` zod tipleri; `RevisionResult` üç varyant; `runRevision` `WorktreeSession`/`Board`/seam'ler alır.
- **Döngü mantığı:** approve→approved(round-1); round===rounds & changes→final (accept/ask-human); else postComments+senior+commit/push. `Math.max(1, maxRounds)` sonsuz-tur/erişilmez guard.
- **Abort:** try/catch yok → principalReview/seniorRevise/manager throw'u propagate; pre-aborted testi doğrular.
- **senior ana worktree'de:** cwd=session.baseWorktree, `createDefaultRegistry` (tam tool) — izole worktree yok.
