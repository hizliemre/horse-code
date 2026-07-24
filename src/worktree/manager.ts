import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultGitRunner, type GitRunner } from "./git.js";
import { toSlug, uniqueSlug } from "./slug.js";
import { readCheckpoint, checkpointKey, isContinuePrompt, checkpointMtime } from "../engine/checkpoint.js";

/** Don't let the PR diff bloat the revision prompt: anything above this char limit is truncated. */
const MAX_DIFF_CHARS = 60_000;

export interface WorktreeSession {
  jobSlug: string;
  root: string;
  baseWorktree: string;
  baseBranch: string;
  resumed?: boolean; // true when this session reuses a preserved worktree from an earlier interrupted run
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

  /** Runs git; nonzero exit → throws a clear error. Returns output (stdout). */
  private async run(args: string[], cwd: string): Promise<string> {
    const r = await this.git(args, cwd);
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout;
  }

  /** `git init` the repo if the directory isn't one yet (the user may not have run git init) + ensure an
   *  identity so the first commit doesn't fail on a machine with no global git config. */
  private async ensureRepo(): Promise<void> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"], this.repoRoot);
    if (inside.code === 0 && inside.stdout.trim() === "true") return; // already a git repo
    await this.run(["init", "-b", "main"], this.repoRoot); // not a repo → initialize one automatically
    const email = await this.git(["config", "user.email"], this.repoRoot);
    if (email.code !== 0 || !email.stdout.trim()) {
      // no identity configured (global or local) → set a local fallback so commits succeed
      await this.git(["config", "user.email", "horse-code@local"], this.repoRoot);
      await this.git(["config", "user.name", "horse-code"], this.repoRoot);
    }
  }

  /**
   * A worktree must branch off a commit. First ensure the directory IS a git repo (auto `git init` if not).
   * A freshly `git init`-ed repo has an unborn HEAD (no commits), so `git worktree add … <branch>` fails with
   * "invalid reference". Bootstrap one empty commit so horse-code works in a brand-new / non-git directory.
   */
  private async ensureBaseCommit(): Promise<void> {
    await this.ensureRepo();
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], this.repoRoot);
    if (head.code === 0) return; // repo already has at least one commit
    await this.run(["commit", "--allow-empty", "-m", "hc: initial commit"], this.repoRoot);
  }

  /**
   * The ref to base the session's worktree on. Uses `fromBranch` when it resolves; otherwise falls back to
   * HEAD. This covers the common fresh-repo mismatch: horse-code guesses "main" but the repo's actual
   * (default/unborn) branch is "master", so "main" never resolves even after the bootstrap commit.
   */
  private async resolveBase(fromBranch: string): Promise<string> {
    const ok = await this.git(["rev-parse", "--verify", "--quiet", fromBranch], this.repoRoot);
    return ok.code === 0 ? fromBranch : "HEAD";
  }

  async openSession(fromBranch: string, jobName: string): Promise<WorktreeSession> {
    await this.ensureBaseCommit();
    const base = await this.resolveBase(fromBranch);
    const worktreesDir = join(this.repoRoot, ".horsecode", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    await writeFile(join(worktreesDir, ".gitignore"), "*\n", "utf8");

    // Make the slug unique against BOTH the worktree directory AND existing hc/ branches: a prior run's
    // worktree dir may be gone while its branch `hc/<slug>/base` still lingers in git, which would make
    // `git worktree add -b` fail with "a branch named … already exists".
    const listed = await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/hc/"], this.repoRoot);
    const branches = new Set(listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    const jobSlug = uniqueSlug(toSlug(jobName), (s) => existsSync(join(worktreesDir, s)) || branches.has(`hc/${s}/base`));
    const root = join(worktreesDir, jobSlug);
    const baseWorktree = join(root, "base");
    const baseBranch = `hc/${jobSlug}/base`;
    await mkdir(join(root, "tasks"), { recursive: true });
    await this.run(["worktree", "add", "-b", baseBranch, baseWorktree, base], this.repoRoot);
    return { jobSlug, root, baseWorktree, baseBranch };
  }

  /** Absolute paths of the worktrees git currently tracks (from `git worktree list --porcelain`). */
  private async registeredWorktrees(): Promise<Set<string>> {
    const r = await this.git(["worktree", "list", "--porcelain"], this.repoRoot);
    const paths = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        const p = line.slice("worktree ".length).trim();
        try { paths.add(realpathSync(p)); } catch { paths.add(p); }
      }
    }
    return paths;
  }

  /**
   * Resume support: find a preserved worktree from an earlier interrupted run. Scans every
   * `.horsecode/worktrees/<slug>/checkpoint.json` and only considers a session whose `base` worktree is still
   * live in git (a pruned/stale dir can't be safely reused). A bare "continue" request (`isContinuePrompt`)
   * resumes the MOST RECENTLY touched worktree — the user needn't retype the original request; otherwise the
   * prompt must match a checkpoint's stored `rawPrompt` (case/space-tolerant). Returns null when there is
   * nothing to resume — the caller then opens a fresh session.
   */
  async findResumable(rawPrompt: string): Promise<WorktreeSession | null> {
    const worktreesDir = join(this.repoRoot, ".horsecode", "worktrees");
    if (!existsSync(worktreesDir)) return null;
    // ensureRepo would be needed for the git call below, but if there's a worktrees dir there's already a repo.
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"], this.repoRoot);
    if (inside.code !== 0) return null;
    const anyContinue = isContinuePrompt(rawPrompt);
    const key = checkpointKey(rawPrompt);
    const registered = await this.registeredWorktrees();
    const candidates: { session: WorktreeSession; mtime: number }[] = [];
    for (const slug of readdirSync(worktreesDir)) {
      const root = join(worktreesDir, slug);
      const cp = readCheckpoint(root);
      if (!cp) continue;
      // A generic "continue" matches any preserved work; otherwise require the original prompt to match.
      if (!anyContinue && checkpointKey(cp.rawPrompt) !== key) continue;
      const baseWorktree = join(root, "base");
      // git worktree list reports canonical (symlink-resolved) paths, so compare via realpath — otherwise a
      // repo under a symlinked prefix (e.g. macOS /var → /private/var) would never match.
      let real: string;
      try { real = realpathSync(baseWorktree); } catch { continue; } // dir gone → not resumable
      if (!registered.has(real)) continue; // dir exists but git no longer tracks it → unsafe to reuse
      candidates.push({ session: { jobSlug: slug, root, baseWorktree, baseBranch: `hc/${slug}/base`, resumed: true }, mtime: checkpointMtime(root) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime); // most recently touched first
    return candidates[0].session;
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
    // Not a conflict, some other merge error → surface it.
    throw new Error(`git merge ${task.branch} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }

  /** Files git marks as unmerged (conflicted) in the base worktree. */
  async unmergedFiles(session: WorktreeSession): Promise<string[]> {
    const r = await this.git(["diff", "--name-only", "--diff-filter=U"], session.baseWorktree);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Unified diff of changes in the base worktree against the base branch (the PR diff). */
  async diff(session: WorktreeSession, base: string): Promise<string> {
    const r = await this.git(["diff", `${base}...${session.baseBranch}`], session.baseWorktree);
    const out = r.stdout;
    if (out.length <= MAX_DIFF_CHARS) return out;
    return out.slice(0, MAX_DIFF_CHARS) + `\n… (diff truncated: ${out.length - MAX_DIFF_CHARS} characters omitted)`;
  }

  /**
   * Rejection path: commit whatever draft the worktree holds to its branch (so the work is NOT lost) and
   * KEEP both the worktree directory and the branch, so the user can inspect the produced files directly
   * under .horsecode/worktrees/<slug>/base. Returns the worktree path. (closeSession, by contrast, deletes
   * the worktree + branch — but nothing currently calls it on the happy path; worktrees are kept for inspection.)
   */
  async preserveSession(session: WorktreeSession, message: string): Promise<string> {
    await this.commitMerge(session, message); // stage + commit the spec/plan draft onto the branch
    return session.baseWorktree; // keep the dir + branch → the user browses the files directly
  }

  async commitMerge(session: WorktreeSession, message?: string): Promise<void> {
    await this.run(["add", "-A"], session.baseWorktree);
    const staged = await this.git(["diff", "--cached", "--quiet"], session.baseWorktree);
    if (staged.code === 0) return; // nothing staged → skip commit (avoid nothing-to-commit throw)
    await this.run(message ? ["commit", "-m", message] : ["commit", "--no-edit"], session.baseWorktree);
  }

  /** Commits all changes in the task worktree to the task branch; no-op if there are no changes. */
  async commitTask(task: TaskWorktree, message: string): Promise<void> {
    await this.run(["add", "-A"], task.worktree);
    const staged = await this.git(["diff", "--cached", "--quiet"], task.worktree);
    if (staged.code === 0) return; // no diff → no-op
    await this.run(["commit", "-m", message], task.worktree);
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
    // List all branches, filter by prefix in code (don't rely on git glob's / behavior).
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
    const check = await this.git(["remote", "get-url", remote], session.baseWorktree);
    if (check.code !== 0) return; // no remote → local-only, skip push
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
