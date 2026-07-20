# horse-code Dilim D — Worktree Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `WorktreeManager`'ı inşa etmek — session ana worktree'sini açan, ondan izole task worktree'leri türeten, task branch'lerini base'e merge edip çakışmayı açığa çıkaran, temizleyen, ve base'i push edip enjekte bir adaptörle PR açan saf-git bir sınıf; gerçek geçici git repo'larla tam test edilebilir.

**Architecture:** Tek `WorktreeManager` sınıfı git'i enjekte edilebilir bir `GitRunner` (varsayılan: `child_process` spawn) üzerinden çalıştırır. Slug üretimi (kebab + dedupe) ve git runner ayrı küçük modüller. Çakışma base worktree'yi merge-durumunda bırakır (çözüm Dilim E'nin council'ında); PR enjekte `PRAdapter` ile (gerçek MCP sonra). Testler `git init` edilmiş tmp repo'larda gerçek worktree/merge/conflict semantiğini doğrular.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `git` (≥ 2.28, `init -b` için), `node:child_process`/`node:fs`, `vitest`. Yeni npm bağımlılığı YOK.

## Global Constraints

- Node ≥ 20; TypeScript ESM (`"type":"module"`), `strict:true`, relative import'lar `.js` uzantılı.
- **Saf git mekaniği:** role-agent/council/pipeline orkestrasyonu YOK (Dilim E). D yalnızca git + fs.
- **Git ref D/F kısıtı:** base branch `hc/<jobSlug>/base`, task branch `hc/<jobSlug>/t/<taskSlug>` — `hc/<jobSlug>` namespace'i altında, `hc/<jobSlug>` (dosya) + `hc/<jobSlug>/x` (dizin) çakışması ÖNLENİR. Bu adları AYNEN kullan.
- **Konum:** `<repoRoot>/.horsecode/worktrees/<jobSlug>/{base, tasks/<taskSlug>}`. `openSession` `.horsecode/worktrees/.gitignore` (`*`) yazar.
- **Slug:** kebab-case + filesystem-güvenli; çakışmada `-2`/`-3` dedupe (disk kontrolü).
- **runGit enjekte edilebilir:** `(args, cwd) => Promise<{stdout, stderr, code}>`; varsayılan spawn. Testler happy path'i gerçek git ile, hata yollarını fake runner ile.
- **Çakışma:** `mergeTask` çakışmada merge'i **abort ETMEZ**, base worktree'yi conflict marker'larla bırakır, çakışan dosyaları döner. `commitMerge`/`abortMerge` ayrı çağrılır.
- **Cleanup best-effort:** `removeTask`/`closeSession` git hatalarında sessiz (zaten-gitmiş durumunu tolere et).
- Test framework `vitest`; her task TDD (önce başarısız test). git testleri `mkdtemp` tmp repo'da, `afterEach`'te silinir.

---

### Task 1: Slug Üretimi

**Files:**
- Create: `src/worktree/slug.ts`
- Test: `test/worktree/slug.test.ts`

**Interfaces:**
- Consumes: (yok — saf fonksiyonlar)
- Produces:
  - `toSlug(name: string): string` — küçük harf, `[a-z0-9]` dışı → `-`, tekrar/baş-son `-` sadeleşir; boşsa `"job"`.
  - `uniqueSlug(base: string, taken: (slug: string) => boolean): string` — `taken` true dönerse `-2`, `-3`… ekler.

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/slug.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "../../src/worktree/slug.js";

describe("toSlug", () => {
  it("kebab-case filesystem-güvenli slug üretir", () => {
    expect(toSlug("Add Auth Endpoint!")).toBe("add-auth-endpoint");
    expect(toSlug("a/b  c")).toBe("a-b-c");
    expect(toSlug("--Foo__Bar--")).toBe("foo-bar");
  });
  it("boş/simge-only girdide fallback döner", () => {
    expect(toSlug("   ")).toBe("job");
    expect(toSlug("!!!")).toBe("job");
  });
});

describe("uniqueSlug", () => {
  it("çakışma yoksa base'i döner", () => {
    expect(uniqueSlug("x", () => false)).toBe("x");
  });
  it("çakışmada -2, -3 ekler", () => {
    const taken = new Set(["x", "x-2"]);
    expect(uniqueSlug("x", (s) => taken.has(s))).toBe("x-3");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/slug.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/worktree/slug.ts` yaz**

```typescript
/** İsmi filesystem-güvenli kebab-case slug'a çevirir; boşsa "job". */
export function toSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "job";
}

/** taken(slug) true dönerse -2, -3… ekleyerek tekil slug üretir. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/worktree/slug.test.ts && npm run typecheck`
Expected: PASS; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/slug.ts test/worktree/slug.test.ts
git commit -m "feat: worktree slug üretimi (kebab + dedupe)"
```

---

### Task 2: GitRunner + Tmp-Repo Test Yardımcısı

**Files:**
- Create: `src/worktree/git.ts`
- Create: `test/worktree/helpers.ts`
- Test: `test/worktree/git.test.ts`

**Interfaces:**
- Consumes: `node:child_process`
- Produces:
  - `type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>`
  - `const defaultGitRunner: GitRunner` — `git`'i spawn eder, stdout/stderr toplar, exit kodunu döner (spawn hatası → `code: -1`).
  - `test/worktree/helpers.ts`: `initTmpRepo(): Promise<string>` — `mkdtemp` → `git init -b main` + user config + initial commit; repo yolunu döner. (Task 3–6 testleri bunu tüketir.)

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/git.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

describe("defaultGitRunner", () => {
  it("başarılı komutta stdout + code 0 döner", async () => {
    repo = await initTmpRepo();
    const r = await defaultGitRunner(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("main");
  });
  it("başarısız komutta nonzero code döner (throw etmez)", async () => {
    repo = await initTmpRepo();
    const r = await defaultGitRunner(["this-is-not-a-git-command"], repo);
    expect(r.code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/git.test.ts`
Expected: FAIL — modül(ler) bulunamadı.

- [ ] **Step 3: `src/worktree/git.ts` yaz**

```typescript
import { spawn } from "node:child_process";

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** git'i child_process ile çalıştırır; asla throw etmez, {stdout, stderr, code} döner. */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("git", args, { cwd });
    } catch (e) {
      resolve({ stdout, stderr: e instanceof Error ? e.message : String(e), code: -1 });
      return;
    }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
```

- [ ] **Step 4: `test/worktree/helpers.ts` yaz**

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";

/** Geçici bir git repo başlatır: init -b main + user config + initial commit. Repo yolunu döner. */
export async function initTmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hc-wt-"));
  const g = (args: string[]) => defaultGitRunner(args, dir);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@hc.local"]);
  await g(["config", "user.name", "hc test"]);
  await writeFile(join(dir, "README.md"), "# repo\n", "utf8");
  await g(["add", "-A"]);
  await g(["commit", "-m", "init"]);
  return dir;
}
```

- [ ] **Step 5: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/worktree/git.test.ts && npm run typecheck`
Expected: PASS (2 test); hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/worktree/git.ts test/worktree/helpers.ts test/worktree/git.test.ts
git commit -m "feat: GitRunner (spawn) + initTmpRepo test yardımcısı"
```

---

### Task 3: WorktreeManager — openSession + deriveTask

**Files:**
- Create: `src/worktree/manager.ts`
- Test: `test/worktree/manager.test.ts`

**Interfaces:**
- Consumes: `GitRunner`/`defaultGitRunner` (`./git.js`), `toSlug`/`uniqueSlug` (`./slug.js`), `initTmpRepo` (test)
- Produces:
  - `interface WorktreeSession { jobSlug; root; baseWorktree; baseBranch }`
  - `interface TaskWorktree { taskSlug; worktree; branch }`
  - `type MergeResult`, `interface PRInput`, `interface PRAdapter` (ileriki task'lar için burada tanımlanır)
  - `class WorktreeManager` — kurucu `({ repoRoot, runGit? })`; bu task: `openSession(fromBranch, jobName)` ve `deriveTask(session, taskName)`. Private `run(args, cwd)` (nonzero'da throw).

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/manager.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const r = await defaultGitRunner(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir);
  return r.code === 0;
}

describe("WorktreeManager.openSession", () => {
  it("base worktree + hc/<slug>/base branch oluşturur, .gitignore yazar", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "Add Auth");
    expect(s.jobSlug).toBe("add-auth");
    expect(s.baseBranch).toBe("hc/add-auth/base");
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/add-auth/base")).toBe(true);
    expect(existsSync(join(repo, ".horsecode/worktrees/.gitignore"))).toBe(true);
  });

  it("aynı jobName ikinci kez → slug -2 ile dedupe", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const a = await wm.openSession("main", "job");
    const b = await wm.openSession("main", "job");
    expect(a.jobSlug).toBe("job");
    expect(b.jobSlug).toBe("job-2");
  });
});

describe("WorktreeManager.deriveTask", () => {
  it("base'den türev worktree + hc/<slug>/t/<task> branch oluşturur", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "Create Model");
    expect(t.taskSlug).toBe("create-model");
    expect(t.branch).toBe("hc/job/t/create-model");
    expect(existsSync(t.worktree)).toBe(true);
    expect(await branchExists(repo, "hc/job/t/create-model")).toBe(true);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/manager.test.ts`
Expected: FAIL — modül bulunamadı.

- [ ] **Step 3: `src/worktree/manager.ts` yaz**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultGitRunner, type GitRunner } from "./git.js";
import { toSlug, uniqueSlug } from "./slug.js";

export interface WorktreeSession {
  jobSlug: string;
  root: string;
  baseWorktree: string;
  baseBranch: string;
}
export interface TaskWorktree {
  taskSlug: string;
  worktree: string;
  branch: string;
}
export type MergeResult = { status: "merged" } | { status: "conflict"; files: string[] };
export interface PRInput {
  base: string;
  title: string;
  body: string;
}
export interface PRAdapter {
  createPR(input: { branch: string } & PRInput): Promise<{ url: string; number?: number }>;
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly git: GitRunner;

  constructor(deps: { repoRoot: string; runGit?: GitRunner }) {
    this.repoRoot = deps.repoRoot;
    this.git = deps.runGit ?? defaultGitRunner;
  }

  /** git çalıştırır; nonzero exit → net hata fırlatır. Çıktı (stdout) döner. */
  private async run(args: string[], cwd: string): Promise<string> {
    const r = await this.git(args, cwd);
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} başarısız (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout;
  }

  async openSession(fromBranch: string, jobName: string): Promise<WorktreeSession> {
    const worktreesDir = join(this.repoRoot, ".horsecode", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    await writeFile(join(worktreesDir, ".gitignore"), "*\n", "utf8");

    const jobSlug = uniqueSlug(toSlug(jobName), (s) => existsSync(join(worktreesDir, s)));
    const root = join(worktreesDir, jobSlug);
    const baseWorktree = join(root, "base");
    const baseBranch = `hc/${jobSlug}/base`;
    await mkdir(join(root, "tasks"), { recursive: true });
    await this.run(["worktree", "add", "-b", baseBranch, baseWorktree, fromBranch], this.repoRoot);
    return { jobSlug, root, baseWorktree, baseBranch };
  }

  async deriveTask(session: WorktreeSession, taskName: string): Promise<TaskWorktree> {
    const tasksDir = join(session.root, "tasks");
    const taskSlug = uniqueSlug(toSlug(taskName), (s) => existsSync(join(tasksDir, s)));
    const worktree = join(tasksDir, taskSlug);
    const branch = `hc/${session.jobSlug}/t/${taskSlug}`;
    await this.run(["worktree", "add", "-b", branch, worktree, session.baseBranch], this.repoRoot);
    return { taskSlug, worktree, branch };
  }
}
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/worktree/manager.test.ts && npm run typecheck`
Expected: PASS (3 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/worktree/manager.test.ts
git commit -m "feat: WorktreeManager openSession + deriveTask"
```

---

### Task 4: WorktreeManager — mergeTask + commitMerge + abortMerge

**Files:**
- Modify: `src/worktree/manager.ts` (üç metot eklenir)
- Test: `test/worktree/merge.test.ts`

**Interfaces:**
- Consumes: `WorktreeManager`, `WorktreeSession`, `TaskWorktree`, `MergeResult` (Task 3)
- Produces:
  - `mergeTask(session, task): Promise<MergeResult>` — `baseWorktree`'de `git merge <task.branch>`; başarı → `{merged}`; çakışma → merge'i bırak, `git diff --name-only --diff-filter=U` ile dosyalar → `{conflict, files}`; başka hata → throw.
  - `commitMerge(session, message?): Promise<void>` — `git add -A` + `git commit --no-edit` (veya `-m message`).
  - `abortMerge(session): Promise<void>` — `git merge --abort`.

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/merge.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

// Task worktree'sinde README'yi değiştirip commit'ler.
async function editAndCommit(worktree: string, content: string): Promise<void> {
  await writeFile(join(worktree, "README.md"), content, "utf8");
  await defaultGitRunner(["add", "-A"], worktree);
  await defaultGitRunner(["commit", "-m", "değişiklik"], worktree);
}

describe("WorktreeManager merge yaşam döngüsü", () => {
  it("çakışmasız task base'e merge olur (merged)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "a");
    await editAndCommit(t.worktree, "A\n");
    const res = await wm.mergeTask(s, t);
    expect(res.status).toBe("merged");
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("A\n");
  });

  it("aynı dosyayı değiştiren iki task ikinci merge'de çakışır", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    expect((await wm.mergeTask(s, ta)).status).toBe("merged"); // ff
    const res = await wm.mergeTask(s, tb);
    expect(res).toEqual({ status: "conflict", files: ["README.md"] });
  });

  it("commitMerge çözülen çakışmayı tamamlar", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    await wm.mergeTask(s, ta);
    await wm.mergeTask(s, tb); // conflict
    await writeFile(join(s.baseWorktree, "README.md"), "ÇÖZÜLDÜ\n", "utf8"); // council çözümü simülasyonu
    await wm.commitMerge(s);
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("ÇÖZÜLDÜ\n");
    const status = await defaultGitRunner(["status", "--porcelain"], s.baseWorktree);
    expect(status.stdout.trim()).toBe(""); // temiz, merge tamam
  });

  it("abortMerge çakışmayı geri alır (base temiz)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    await wm.mergeTask(s, ta);
    await wm.mergeTask(s, tb); // conflict
    await wm.abortMerge(s);
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("A\n"); // ta durumu
    const status = await defaultGitRunner(["status", "--porcelain"], s.baseWorktree);
    expect(status.stdout.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/merge.test.ts`
Expected: FAIL — `mergeTask` yok.

- [ ] **Step 3: `src/worktree/manager.ts`'e üç metodu ekle (sınıf içine)**

```typescript
  async mergeTask(session: WorktreeSession, task: TaskWorktree): Promise<MergeResult> {
    const r = await this.git(["merge", task.branch], session.baseWorktree);
    if (r.code === 0) return { status: "merged" };
    const diff = await this.git(
      ["diff", "--name-only", "--diff-filter=U"],
      session.baseWorktree,
    );
    const files = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) return { status: "conflict", files };
    // Çakışma değil, başka bir merge hatası → yüzeye çıkar.
    throw new Error(`git merge ${task.branch} başarısız (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }

  async commitMerge(session: WorktreeSession, message?: string): Promise<void> {
    await this.run(["add", "-A"], session.baseWorktree);
    await this.run(message ? ["commit", "-m", message] : ["commit", "--no-edit"], session.baseWorktree);
  }

  async abortMerge(session: WorktreeSession): Promise<void> {
    await this.run(["merge", "--abort"], session.baseWorktree);
  }
```

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/worktree/merge.test.ts && npm run typecheck`
Expected: PASS (4 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/worktree/merge.test.ts
git commit -m "feat: WorktreeManager mergeTask/commitMerge/abortMerge (çakışmayı açığa çıkarır)"
```

---

### Task 5: WorktreeManager — removeTask + closeSession

**Files:**
- Modify: `src/worktree/manager.ts` (iki metot + `rm` import)
- Test: `test/worktree/cleanup.test.ts`

**Interfaces:**
- Consumes: `WorktreeManager`, `WorktreeSession`, `TaskWorktree` (Task 3)
- Produces:
  - `removeTask(session, task): Promise<void>` — task worktree'yi kaldırır + task branch'ini siler (best-effort).
  - `closeSession(session): Promise<void>` — `root` dizinini siler, `git worktree prune`, `hc/<jobSlug>/*` branch'lerini siler (best-effort).

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/cleanup.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const r = await defaultGitRunner(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir);
  return r.code === 0;
}

describe("WorktreeManager cleanup", () => {
  it("removeTask task worktree'sini ve branch'ini kaldırır", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "a");
    await wm.removeTask(s, t);
    expect(existsSync(t.worktree)).toBe(false);
    expect(await branchExists(repo, t.branch)).toBe(false);
  });

  it("closeSession tüm worktree'leri ve session branch'lerini temizler", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    await wm.deriveTask(s, "a"); // temizlenmeden bırakılan task
    await wm.closeSession(s);
    expect(existsSync(s.root)).toBe(false);
    expect(await branchExists(repo, s.baseBranch)).toBe(false);
    expect(await branchExists(repo, "hc/job/t/a")).toBe(false);
    const list = await defaultGitRunner(["worktree", "list", "--porcelain"], repo);
    expect(list.stdout).not.toContain("hc/job");
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/cleanup.test.ts`
Expected: FAIL — `removeTask` yok.

- [ ] **Step 3: `src/worktree/manager.ts`'e ekle**

Dosya başındaki `import { mkdir, writeFile } from "node:fs/promises";` satırını güncelle:
```typescript
import { mkdir, writeFile, rm } from "node:fs/promises";
```

Sınıf içine iki metodu ekle (cleanup best-effort → `this.git` doğrudan, hata yutulur):
```typescript
  async removeTask(session: WorktreeSession, task: TaskWorktree): Promise<void> {
    await this.git(["worktree", "remove", "--force", task.worktree], this.repoRoot);
    await this.git(["branch", "-D", task.branch], this.repoRoot);
  }

  async closeSession(session: WorktreeSession): Promise<void> {
    await rm(session.root, { recursive: true, force: true });
    await this.git(["worktree", "prune"], this.repoRoot);
    // Tüm branch'leri listele, prefix ile kod'da filtrele (git glob'unun / davranışına güvenme).
    const prefix = `hc/${session.jobSlug}/`;
    const list = await this.git(["branch", "--list"], this.repoRoot);
    const branches = list.stdout
      .split("\n")
      .map((s) => s.replace(/^[*+ ]+/, "").trim())
      .filter((b) => b.startsWith(prefix));
    for (const b of branches) {
      await this.git(["branch", "-D", b], this.repoRoot);
    }
  }
```

> Not: `closeSession` önce `root` dizinini siler (worktree checkout'ları gider), sonra `prune`
> (kayıt sicilini temizler), sonra branch'leri siler (artık checked-out değiller → `-D` çalışır).

- [ ] **Step 4: Testin geçtiğini doğrula + typecheck**

Run: `npx vitest run test/worktree/cleanup.test.ts && npm run typecheck`
Expected: PASS (2 test); hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/worktree/cleanup.test.ts
git commit -m "feat: WorktreeManager removeTask + closeSession (best-effort cleanup)"
```

---

### Task 6: WorktreeManager — push + openPR

**Files:**
- Modify: `src/worktree/manager.ts` (iki metot eklenir)
- Test: `test/worktree/pr.test.ts`

**Interfaces:**
- Consumes: `WorktreeManager`, `WorktreeSession`, `PRInput`, `PRAdapter` (Task 3)
- Produces:
  - `push(session, remote?): Promise<void>` — `baseWorktree`'de `git push <remote="origin"> <baseBranch>`.
  - `openPR(session, adapter, input): Promise<{ url: string }>` — `adapter.createPR({ branch: baseBranch, ...input })` çağırır, `{url}` döner.

- [ ] **Step 1: Başarısız testi yaz**

`test/worktree/pr.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { PRAdapter } from "../../src/worktree/manager.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
let bare: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  if (bare) await rm(bare, { recursive: true, force: true });
  repo = bare = undefined;
});

describe("WorktreeManager push", () => {
  it("base branch'i remote'a push eder", async () => {
    repo = await initTmpRepo();
    bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
    await defaultGitRunner(["remote", "add", "origin", bare], repo);
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    await wm.push(s);
    const r = await defaultGitRunner(["rev-parse", "--verify", `refs/heads/${s.baseBranch}`], bare);
    expect(r.code).toBe(0); // bare remote'ta branch var
  });
});

describe("WorktreeManager openPR", () => {
  it("adaptörü doğru argümanlarla çağırır ve url döner", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    let captured: unknown;
    const adapter: PRAdapter = {
      createPR: async (input) => {
        captured = input;
        return { url: "https://pr/1", number: 1 };
      },
    };
    const res = await wm.openPR(s, adapter, { base: "main", title: "T", body: "B" });
    expect(res).toEqual({ url: "https://pr/1" });
    expect(captured).toEqual({ branch: "hc/job/base", base: "main", title: "T", body: "B" });
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `npx vitest run test/worktree/pr.test.ts`
Expected: FAIL — `push` yok.

- [ ] **Step 3: `src/worktree/manager.ts`'e ekle**

```typescript
  async push(session: WorktreeSession, remote = "origin"): Promise<void> {
    await this.run(["push", remote, session.baseBranch], session.baseWorktree);
  }

  async openPR(
    session: WorktreeSession,
    adapter: PRAdapter,
    input: PRInput,
  ): Promise<{ url: string }> {
    const res = await adapter.createPR({
      branch: session.baseBranch,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { url: res.url };
  }
```

- [ ] **Step 4: Testin geçtiğini doğrula + tüm suite + typecheck**

Run: `npx vitest run test/worktree/pr.test.ts && npm test && npm run typecheck`
Expected: PASS; tüm suite yeşil; hata yok.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/worktree/pr.test.ts
git commit -m "feat: WorktreeManager push + openPR (enjekte PRAdapter)"
```

---

## Dilim Sonu Doğrulaması

Tüm task'lar bittiğinde:

- [ ] `npm run typecheck` — hata yok
- [ ] `npm test` — tüm testler PASS (Foundation + B + C + D)
- [ ] `git log --oneline` — bu dilimde 6 commit

Bu dilim şunu teslim eder: `WorktreeManager` — session/task worktree yaşam döngüsü, merge (çakışmayı açığa çıkaran) + commit/abort, cleanup, push + enjekte `PRAdapter` ile PR. Sonraki dilim **E — Board engine + coding mechanism** bunu (worktree izolasyonu, dalga-merge, çakışma-council) ve Dilim C role-agent'ını tüketerek coder/reviewer/team-lead'i koşturur.

## Kapsam Dışı (bilinçli — sonraki dilimler)

- Gerçek MCP `PRAdapter` implementasyonu (GitHub/Azure sağlayıcı seçimi, auth) → sonraki entegrasyon dilimi.
- Conflict-resolution council (role-agent'larla) → Dilim E; D yalnızca çakışmayı açığa çıkarır.
- Dalga döngüsü orkestrasyonu (team-lead, bağımlılık grafiği) → Dilim E.
- `git merge --no-ff` seçeneği (her task ayrı merge commit) → gerekirse ileride; MVP varsayılan merge.
