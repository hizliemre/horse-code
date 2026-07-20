# Dilim G2 — Gerçek PR Adapter + runJob Entegrasyonu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revision'ı gerçekleştir: gerçek gh/az PR adapter + `runJob`'da (wave completed) PR diff'iyle `runRevision`. G1 #1 (diff-scoping) çözülür.

**Architecture:** `src/adapters/pr.ts` = CmdRunner + gh/az/log adapter'lar + platform tespiti (self-contained, inline unknown-stub → wiring↔adapters döngüsü yok). `manager.diff` (D) + `runRevision` `prDiff` (opsiyonel-son). `runJob` revision entegrasyonu. `cli` gerçek adapter wiring.

**Tech Stack:** TypeScript ESM, vitest, node:child_process (spawn), fake CmdRunner + gerçek tmp git.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli.
- vitest, **TDD**; **fake `CmdRunner`** (komutları kaydeder, sabit çıktı) — gh/az test'te KOŞMAZ; gerçek tmp git (diff için) + içerik-provider (revision).
- **Abort/geriye dönük uyum:** `runRevision`'a `prDiff` **opsiyonel-son param** (G1 testleri değişmez).
- **Döngü yok:** `adapters/pr.ts` self-contained (unknown-stub inline); `wiring.ts` yalnız `RevisionPRAdapter` **tipini** (type-only) import eder.
- **az yorumları best-effort log** (thread REST ileride); gh full.

---

### Task 1: `src/adapters/pr.ts` — CmdRunner + gh/az/make adapter'lar

**Files:**
- Create: `src/adapters/pr.ts`
- Modify: `src/wiring.ts` (logPRAdapter → RevisionPRAdapter; buildJobDeps opts.prAdapter tipi)
- Test: `test/adapters/pr.test.ts`

**Interfaces:**
- Produces: `CmdRunner`/`defaultCmdRunner`, `RevisionPRAdapter`, `parsePRNumber`, `ghAdapter`, `azAdapter`, `detectPlatform`, `makePRAdapter`.

- [ ] **Step 1: Kırmızı test**

`test/adapters/pr.test.ts` oluştur:

```typescript
import { describe, it, expect } from "vitest";
import { parsePRNumber, ghAdapter, azAdapter, detectPlatform, makePRAdapter, type CmdRunner } from "../../src/adapters/pr.js";

function fakeRunner(out: { stdout?: string; code?: number } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = (async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { stdout: out.stdout ?? "", stderr: "", code: out.code ?? 0 }; }) as CmdRunner & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn as CmdRunner & { calls: { cmd: string; args: string[] }[] };
}

describe("parsePRNumber", () => {
  it("github/azure url → number; geçersiz → undefined", () => {
    expect(parsePRNumber("https://github.com/o/r/pull/7")).toBe(7);
    expect(parsePRNumber("https://dev.azure.com/o/p/_git/r/pullrequest/45")).toBe(45);
    expect(parsePRNumber("x")).toBeUndefined();
  });
});

describe("ghAdapter", () => {
  it("createPR gh komutunu kurar, url→number; postComments gh comment kurar", async () => {
    const run = fakeRunner({ stdout: "https://github.com/o/r/pull/7\n" });
    const a = ghAdapter(run, "/repo");
    const pr = await a.createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(pr.number).toBe(7);
    expect(run.calls[0]).toEqual({ cmd: "gh", args: ["pr", "create", "--base", "main", "--head", "hc/j/base", "--title", "T", "--body", "B"] });
    await a.postComments(["ilk", "ikinci"]);
    expect(run.calls[1].cmd).toBe("gh");
    expect(run.calls[1].args.slice(0, 3)).toEqual(["pr", "comment", "7"]);
    expect(run.calls[1].args[4]).toContain("ilk");
  });
  it("PR açılmadan postComments no-op", async () => {
    const run = fakeRunner();
    await ghAdapter(run, "/repo").postComments(["x"]);
    expect(run.calls.length).toBe(0);
  });
  it("createPR başarısızsa fırlatır", async () => {
    const run = fakeRunner({ code: 1 });
    await expect(ghAdapter(run, "/repo").createPR({ branch: "b", base: "main", title: "T", body: "B" })).rejects.toThrow();
  });
});

describe("azAdapter", () => {
  it("createPR az komutunu kurar (JSON→number); postComments log'lar", async () => {
    const run = fakeRunner({ stdout: '{"pullRequestId":45,"url":"http://az/45"}' });
    const logs: string[] = [];
    const a = azAdapter(run, "/repo", (s) => logs.push(s));
    const pr = await a.createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(pr.number).toBe(45);
    expect(run.calls[0].cmd).toBe("az");
    expect(run.calls[0].args.slice(0, 3)).toEqual(["repos", "pr", "create"]);
    await a.postComments(["bulgu"]);
    expect(logs.some((l) => l.includes("bulgu"))).toBe(true);
  });
});

describe("detectPlatform", () => {
  it("github/azure/unknown", () => {
    expect(detectPlatform("git@github.com:o/r.git")).toBe("github");
    expect(detectPlatform("https://dev.azure.com/o/p/_git/r")).toBe("azure");
    expect(detectPlatform("https://gitlab.com/o/r.git")).toBe("unknown");
  });
});

describe("makePRAdapter", () => {
  it("github→gh, azure→az, unknown→log-stub", async () => {
    const ghRun = fakeRunner({ stdout: "https://github.com/o/r/pull/1" });
    const gh = makePRAdapter({ platform: "github", run: ghRun, cwd: "/r", log: () => {} });
    await gh.createPR({ branch: "b", base: "main", title: "T", body: "B" });
    expect(ghRun.calls[0].cmd).toBe("gh");

    const logs: string[] = [];
    const unk = makePRAdapter({ platform: "unknown", run: fakeRunner(), cwd: "/r", log: (s) => logs.push(s) });
    const pr = await unk.createPR({ branch: "b", base: "main", title: "T", body: "B" });
    expect(pr.url).toContain("bilinmeyen");
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/adapters/pr.test.ts`
Expected: FAIL — `adapters/pr.js` yok.

- [ ] **Step 3: adapters/pr.ts implement**

`src/adapters/pr.ts` oluştur:

```typescript
import { spawn } from "node:child_process";
import type { PRAdapter } from "../worktree/manager.js";

export type CmdRunner = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Komutu child_process ile çalıştırır; asla throw etmez (GitRunner gibi). */
export const defaultCmdRunner: CmdRunner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try { child = spawn(cmd, args, { cwd }); }
    catch (e) { resolve({ stdout, stderr: e instanceof Error ? e.message : String(e), code: -1 }); return; }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });

export interface RevisionPRAdapter extends PRAdapter {
  postComments(comments: string[]): Promise<void>;
}

export function parsePRNumber(url: string): number | undefined {
  const m = url.match(/\/(?:pull|pullrequest)\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function joinComments(comments: string[]): string {
  return comments.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/** GitHub: gh pr create / gh pr comment. Stateful (PR number'ı saklar). */
export function ghAdapter(run: CmdRunner, cwd: string): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("gh", ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body], cwd);
      if (r.code !== 0) throw new Error(`gh pr create başarısız (${r.code}): ${r.stderr.trim()}`);
      const url = r.stdout.trim();
      prNumber = parsePRNumber(url);
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (prNumber === undefined || comments.length === 0) return;
      const r = await run("gh", ["pr", "comment", String(prNumber), "--body", joinComments(comments)], cwd);
      if (r.code !== 0) throw new Error(`gh pr comment başarısız (${r.code}): ${r.stderr.trim()}`);
    },
  };
}

/** Azure: az repos pr create (JSON). Yorumlar best-effort log (thread REST ileride). */
export function azAdapter(run: CmdRunner, cwd: string, log: (s: string) => void): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("az", ["repos", "pr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "-o", "json"], cwd);
      if (r.code !== 0) throw new Error(`az repos pr create başarısız (${r.code}): ${r.stderr.trim()}`);
      let url = "";
      try {
        const j = JSON.parse(r.stdout) as { pullRequestId?: number; url?: string };
        prNumber = typeof j.pullRequestId === "number" ? j.pullRequestId : undefined;
        url = j.url ?? `(azure PR #${prNumber ?? "?"})`;
      } catch { url = r.stdout.trim() || "(azure PR)"; }
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (comments.length === 0) return;
      log(`Azure PR #${prNumber ?? "?"} yorumları (thread API ileride):\n${joinComments(comments)}`);
    },
  };
}

export function detectPlatform(remoteUrl: string): "github" | "azure" | "unknown" {
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("dev.azure.com") || remoteUrl.includes("visualstudio.com")) return "azure";
  return "unknown";
}

/** Platforma göre adapter; unknown → log-stub (PR açılmaz). */
export function makePRAdapter(opts: { platform: "github" | "azure" | "unknown"; run: CmdRunner; cwd: string; log: (s: string) => void }): RevisionPRAdapter {
  if (opts.platform === "github") return ghAdapter(opts.run, opts.cwd);
  if (opts.platform === "azure") return azAdapter(opts.run, opts.cwd, opts.log);
  return {
    async createPR(input) {
      opts.log(`PR (bilinmeyen platform): ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(bilinmeyen platform — PR açılmadı)" };
    },
    async postComments(comments) {
      if (comments.length) opts.log(`PR yorumları: ${comments.join("; ")}`);
    },
  };
}
```

- [ ] **Step 4: wiring.ts logPRAdapter → RevisionPRAdapter**

`src/wiring.ts`: `import type { RevisionPRAdapter } from "./adapters/pr.js";` ekle. `logPRAdapter`'ı güncelle:

```typescript
export function logPRAdapter(log: (s: string) => void): RevisionPRAdapter {
  return {
    async createPR(input) {
      log(`PR açılacaktı: ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(pending: G — gerçek MCP)" };
    },
    async postComments(comments) {
      if (comments.length) log(`PR yorumları: ${comments.join("; ")}`);
    },
  };
}
```

`BuildJobDepsOpts.prAdapter` tipini `PRAdapter` → `RevisionPRAdapter` yap (import type ekle).

- [ ] **Step 5: Testler + typecheck**

Run: `npx vitest run test/adapters/pr.test.ts test/wiring.test.ts`
Expected: PASS (adapter testleri + mevcut wiring testleri — logPRAdapter re-export/güncel, buildJobDeps RevisionPRAdapter kabul eder).
Run: `npm run typecheck` → temiz (JobDeps.prAdapter hâlâ PRAdapter; RevisionPRAdapter atanabilir).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/pr.ts src/wiring.ts test/adapters/pr.test.ts
git commit -m "feat: gh/az PR adapter'ları + CmdRunner + detectPlatform/makePRAdapter"
```

---

### Task 2: `manager.diff` (D) + `runRevision` `prDiff`

**Files:**
- Modify: `src/worktree/manager.ts` (diff)
- Modify: `src/engine/revision.ts` (prDiff param)
- Test: `test/worktree/diff.test.ts`, `test/engine/revision.test.ts`

**Interfaces:**
- Produces: `WorktreeManager.diff(session, base): Promise<string>`; `runRevision(..., maxRounds, prDiff?)` — `prDiff` opsiyonel-son, `principalReview`'ya taşınır.

- [ ] **Step 1: Kırmızı test — diff**

`test/worktree/diff.test.ts` oluştur:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.diff", () => {
  it("base'e karşı baseBranch değişikliklerini unified diff'te verir", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    await writeFile(join(s.baseWorktree, "yeni.txt"), "içerik\n", "utf8");
    const g = (args: string[]) => defaultGitRunner(args, s.baseWorktree);
    await g(["add", "-A"]);
    await g(["commit", "-m", "değişiklik"]);
    const d = await mgr.diff(s, "main");
    expect(d).toContain("yeni.txt");
    expect(d).toContain("içerik");
  });
});
```

- [ ] **Step 2: diff çalıştır — kırmızı**

Run: `npx vitest run test/worktree/diff.test.ts`
Expected: FAIL — `diff` metodu yok.

- [ ] **Step 3: manager.diff implement**

`src/worktree/manager.ts` — `commitMerge`/`unmergedFiles` yanına ekle:

```typescript
  /** base branch'e karşı base worktree'deki değişikliklerin unified diff'i (PR diff'i). */
  async diff(session: WorktreeSession, base: string): Promise<string> {
    const r = await this.git(["diff", `${base}...${session.baseBranch}`], session.baseWorktree);
    return r.stdout;
  }
```

- [ ] **Step 4: runRevision prDiff — kırmızı test**

`test/engine/revision.test.ts`'e ekle (mevcut helper'ları kullan):

```typescript
  it("prDiff verilince principal review isteği diff'i içerir", async () => {
    // requests yakalayan basit provider
    const requests: import("../../src/core/types.js").ChatRequest[] = [];
    const p: import("../../src/core/types.js").Provider = {
      async *chat(req) {
        requests.push(req);
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("P-principal")) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"decision":"approve","comments":[]}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await runRevision(rdeps(p, fakeManager()), session(dir), new Board(), async () => {}, async () => "x", 1, "DIFF-XYZ-123");
    const principalReq = requests.find((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes("DIFF-XYZ-123")));
    expect(principalReq).toBeDefined();
  });
```

- [ ] **Step 5: revision test — kırmızı**

Run: `npx vitest run test/engine/revision.test.ts`
Expected: FAIL — `prDiff` param yok / mesajda geçmiyor.

- [ ] **Step 6: runRevision prDiff implement**

`src/engine/revision.ts`:
- `principalReview` imzasına `prDiff?: string` ekle; mesajı koşullu yap:

```typescript
async function principalReview(deps: RevisionDeps, base: string, prDiff?: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const content = prDiff
    ? `PR review: şu diff'i incele:\n${prDiff}\n(gerekirse read-tool'larla worktree'yi de incele.) approve veya request-changes + somut comment'ler ver.`
    : "PR review: base worktree'deki tüm değişiklikleri bütünsel incele. approve veya request-changes + somut comment'ler ver.";
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalReviewSchema);
}
```

- `runRevision` imzasına `prDiff?: string` ekle (son param); `principalReview(deps, base)` → `principalReview(deps, base, prDiff)`.

- [ ] **Step 7: Testler + typecheck**

Run: `npx vitest run test/worktree/diff.test.ts test/engine/revision.test.ts`
Expected: PASS (diff + mevcut 5 revision testi + yeni prDiff testi; eski testler prDiff'siz geçer).
Run: `npm run typecheck` → temiz.

- [ ] **Step 8: Commit**

```bash
git add src/worktree/manager.ts src/engine/revision.ts test/worktree/diff.test.ts test/engine/revision.test.ts
git commit -m "feat: WorktreeManager.diff + runRevision prDiff (G1 #1 diff-scoping)"
```

---

### Task 3: `runJob` revision entegrasyonu

**Files:**
- Modify: `src/engine/job.ts`
- Test: `test/engine/job.test.ts`

**Interfaces:**
- Produces: `JobDeps.prAdapter: RevisionPRAdapter`; `JobResult` `done` varyantı kazanır `revision?: RevisionResult`; `runJob` opts kazanır `revisionRounds?`; wave completed → diff → runRevision.

- [ ] **Step 1: Kırmızı test**

`test/engine/job.test.ts` — `jobProvider`'a principal-coder ekle (P-principal → approve) ve `fakeAdapter`'a `postComments` ekle:

```typescript
      // jobProvider chat içinde, P-reviewer'dan sonra:
      if (sys.includes("P-principal")) { yield* submit('{"decision":"approve","comments":[]}'); return; }
```

```typescript
function fakeAdapter(): PRAdapter & { calls: number; comments: string[][] } {
  const a = { calls: 0, comments: [] as string[][], async createPR() { a.calls++; return { url: "http://pr/1", number: 1 }; }, async postComments(c: string[]) { a.comments.push(c); } };
  return a;
}
```

`done` testine ekle (mevcut assertion'ların yanına):

```typescript
      if (res.kind === "done") {
        expect(res.revision?.status).toBe("approved");   // principal ilk turda onayladı
      }
```

`jdeps`'te `roles`'a `"principal-coder": { models: ["m"], systemPrompt: "P-principal" }` ekle (yoksa; H2'de zaten config.model ile çözülür ama test roles'unda açık ver).

Yeni test — principal değişiklik ister → revision koşar + postComments:

```typescript
  it("done: principal değişiklik ister → revision (senior düzeltir, postComments)", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const adapter = fakeAdapter();
      // principal: round1 request-changes, round2 approve
      const p = jobProvider({ intent: "feature", principal: ['{"decision":"request-changes","comments":["testsiz"]}', '{"decision":"approve","comments":[]}'] });
      const res = await runJob(jdeps(p, mgr, adapter), { prompt: "X", fromBranch: "main", jobName: "job", askUser: async () => "x", maxRounds: 2, revisionRounds: 3 });
      expect(res.kind).toBe("done");
      if (res.kind === "done") expect(res.revision?.status).toBe("approved");
      expect(adapter.comments).toEqual([["testsiz"]]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
```

> **jobProvider genişlet:** P-principal review'ları için `opts.principal?: string[]` counter (P-judge gibi); "SON KARAR" içeren mesaj → final (varsayılan accept). P-senior-coder zaten no-op mu? Revision'da senior yazmalı → P-senior-coder branch'i write_file(fix.txt) yapsın (H1'de no-op'tu; revision testi için: senior no tool → write_file("fix.txt"), sonra done). Bu değişiklik yalnız test provider'ında.

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/engine/job.test.ts`
Expected: FAIL — `revision` JobResult'ta yok / runJob revision koşmuyor.

- [ ] **Step 3: job.ts implement**

`src/engine/job.ts`:
- import: `import { runRevision, type RevisionResult } from "./revision.js";` ve `import type { RevisionPRAdapter } from "../adapters/pr.js";`
- `JobDeps.prAdapter: PRAdapter` → `RevisionPRAdapter` (import değişir; `PRAdapter` import'u kalkabilir).
- `JobResult` `done` varyantına `revision?: RevisionResult` ekle.
- `runJob` opts imzasına `revisionRounds?: number` ekle.
- done akışı (mevcut `const wave = ...` sonrası):

```typescript
  const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
  let revision: RevisionResult | undefined;
  if (wave.status === "completed") {
    const prDiff = await deps.manager.diff(session, opts.fromBranch);
    revision = await runRevision(
      deps, session, board,
      (c) => deps.prAdapter.postComments(c),
      opts.askUser, opts.revisionRounds ?? 3, prDiff,
    );
  }
  const report = await runCoachReport(deps, session, board);
  return { kind: "done", wave, revision, report, session };
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/engine/job.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + tüm suite**

Run: `npm run typecheck && npm test`
Expected: temiz + tüm testler yeşil.

- [ ] **Step 6: Commit**

```bash
git add src/engine/job.ts test/engine/job.test.ts
git commit -m "feat: runJob revision entegrasyonu (wave completed → diff → runRevision)"
```

---

### Task 4: cli.ts — gerçek adapter wiring

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `parseArgs` `--revision-rounds` flag; `renderResult` done'da `revision` satırı; `main` gerçek adapter (`detectPlatform` + `defaultCmdRunner` + `makePRAdapter`) kullanır.

- [ ] **Step 1: Kırmızı test**

`test/cli.test.ts`'e ekle:

```typescript
  it("parseArgs --revision-rounds", () => {
    expect(parseArgs(["X", "--revision-rounds", "2"])).toEqual({ prompt: "X", revisionRounds: 2 });
  });
  it("renderResult done: revision durumunu yazar", () => {
    const out = renderResult({
      kind: "done", report: "rapor",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [] },
      revision: { status: "approved", rounds: 0 },
      session: {} as never,
    });
    expect(out).toContain("revision");
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — revisionRounds/revision satırı yok.

- [ ] **Step 3: cli.ts güncelle**

- `CliArgs`'a `revisionRounds?: number` ekle; `parseArgs`'ta `--revision-rounds` flag'i (Number).
- `renderResult` done dalına revision satırı ekle:

```typescript
  const rev = res.revision ? `\nRevision: ${res.revision.status}` : "";
  return `${res.report}\n\nDurum: ${res.wave.status} — ${pr}${rev}`;
```

- `main`: `logPRAdapter` yerine gerçek adapter. import: `import { makePRAdapter, detectPlatform, defaultCmdRunner } from "./adapters/pr.js";` (logPRAdapter import'unu kaldır). WorktreeManager'dan sonra:

```typescript
  const remoteUrl = (await defaultGitRunner(["remote", "get-url", "origin"], cwd)).stdout.trim();
  const prAdapter = makePRAdapter({ platform: detectPlatform(remoteUrl), run: defaultCmdRunner, cwd, log: (s) => console.log(s) });
```

  `buildJobDeps({ ..., prAdapter, ... })` (logPRAdapter yerine). `runJob(deps, { ..., revisionRounds: args.revisionRounds })`.

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + tüm suite + typecheck**

Run: `npm run typecheck && npm run build && test -f dist/cli.js && npm test`
Expected: typecheck temiz; `dist/cli.js` üretilir; tüm testler yeşil.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: cli gerçek PR adapter wiring (detectPlatform + makePRAdapter) + --revision-rounds"
```

---

## Self-Review Notu

- **Spec coverage:** §2 adapter katmanı → Task 1; §3 diff + §4 prDiff → Task 2; §5 runJob entegrasyonu → Task 3; §6 cli wiring → Task 4. Tümü karşılandı.
- **Döngü yok:** adapters/pr.ts self-contained (unknown-stub inline); wiring.ts yalnız RevisionPRAdapter tipini (type-only) alır.
- **Geriye dönük uyum:** `runRevision` `prDiff` opsiyonel-son → G1 testleri değişmez; `logPRAdapter` postComments kazanır (mevcut createPR testi geçer).
- **Type:** JobDeps.prAdapter RevisionPRAdapter (Task 3) → runRevision deps.prAdapter.postComments; JobDeps.manager (full) `diff` içerir (Task 2).
- **Test:** gh/az fake CmdRunner (koşmaz); diff gerçek tmp git; revision içerik-provider; runJob uçtan-uca (bare remote).
