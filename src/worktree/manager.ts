import { mkdir, writeFile, rm } from "node:fs/promises";
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
}
