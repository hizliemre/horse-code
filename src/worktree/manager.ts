import { rename, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { inheritFromRoot, topUpInherited, type Inherited } from "./inherit.js";
import { defaultGitRunner, type GitRunner } from "./git.js";
import { toSlug, uniqueSlug } from "./slug.js";
import { readCheckpoint, checkpointKey, isContinuePrompt, checkpointMtime } from "../engine/checkpoint.js";
import { traceRootRel } from "../engine/trace.js";

/**
 * How much of the diff a reviewer is given.
 *
 * It was 60,000, and that could not hold one medium feature's source: measured on PR #765, the changed
 * `.ts`/`.json` came to 66,913 characters with every document already excluded. A ceiling that cannot fit
 * the code is not a bloat guard, it is a guarantee the code goes unreviewed.
 */
export const MAX_DIFF_CHARS = 120_000;

/** Prose the run produced ABOUT the work — read after the work, never instead of it. */
const DOC_SPECS = ["*.md", "*.txt"];

/**
 * horse-code's own state, kept OUT of the diff it asks a reviewer to review.
 *
 * These files are committed on purpose — memory and the code graph are shared with the project — but they
 * are horse-code's bookkeeping, not the work. Measured on PR #765: the diff was 70,673,949 characters, and
 * the 60,000 a reviewer is given held exactly two files, `.gitignore` and `.horsecode/memory.jsonl`. All 36
 * source files fell outside it. The round that trusted what it was handed spent itself writing seven
 * findings about memory-entry ID suffixes and counter drift, and told the author the pull request "cannot be
 * holistically reviewed" — which was true, and was our doing.
 *
 * `.horsecode/` sorts almost first alphabetically, so this is not bad luck; it is where the file always is.
 */
export function excludeOwnState(): string[] {
  const roots = [".horsecode", "graphify-out", traceRootRel()].filter(Boolean);
  return [...new Set(roots)].map((r) => `:(exclude)${r}/**`);
}

export interface WorktreeSession {
  jobSlug: string;
  root: string;
  baseWorktree: string;
  baseBranch: string;
  resumed?: boolean; // true when this session reuses a preserved worktree from an earlier interrupted run
  /** What the project's working state contributed at open time — see inheritFromRoot. */
  inherited?: Inherited;
  /** Assets a RESUMED session picked up because they did not exist when it was opened. */
  toppedUp?: string[];
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

/**
 * The repository's main checkout, seen from anywhere inside it.
 *
 * A linked worktree shares the repository but is not the repository, and `--git-common-dir` is what points
 * back: from `/main` and from `/anything-linked` alike it names `/main/.git`, whose parent is the checkout
 * that owns the place other checkouts belong under.
 *
 * Falls back to the given directory whenever there is no answer — a bare repository has no working tree to
 * host anything, and a plain directory is not a repository yet.
 */
export async function mainWorktreeRoot(git: GitRunner, cwd: string): Promise<string> {
  const abs = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  // `--path-format` needs git 2.31; without it the answer can be relative, so it is resolved against cwd.
  const r = abs.code === 0 ? abs : await git(["rev-parse", "--git-common-dir"], cwd);
  if (r.code !== 0 || !r.stdout.trim()) return cwd;
  const common = resolve(cwd, r.stdout.trim());
  return basename(common) === ".git" ? dirname(common) : cwd;
}

export class WorktreeManager {
  private readonly repoRoot: string;
  /**
   * Where sessions are kept, which is the REPOSITORY's business and not the caller's checkout.
   *
   * Measured from a live run: started inside another tool's worktree, horse-code opened its session at
   * `…/.claude/worktrees/product-create-wizard/.horsecode/worktrees/…/base` — its own worktree nested inside
   * someone else's, inside the repository. That works and is a place nobody will look: `/clean-worktrees` at
   * the repository root cannot see it, and removing the outer checkout takes it with it.
   *
   * Distinct from `repoRoot` on purpose. What a session INHERITS — the code graph, the memory, the project
   * config — is whatever the user is standing in, and that is frequently not the main checkout.
   */
  private readonly worktreeHome: string;
  private readonly git: GitRunner;

  constructor(deps: { repoRoot: string; worktreeHome?: string; runGit?: GitRunner }) {
    this.repoRoot = deps.repoRoot;
    this.worktreeHome = deps.worktreeHome ?? deps.repoRoot;
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
    const worktreesDir = join(this.worktreeHome, ".horsecode", "worktrees");
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
    /**
     * The branch alone is not the project.
     *
     * A worktree cut from a branch has what was committed and nothing else — not the work in progress, and
     * not the state horse-code itself depends on (the graph, the memory, the constitution, the installed
     * skills), which on a real project was not in git at all. The run must not read those from the root
     * instead: the root is a reference, and nothing written there reaches the pull request. So they come in
     * here, once, and live inside the session from then on.
     */
    const inherited = await inheritFromRoot((args, cwd) => this.git(args, cwd), this.repoRoot, baseWorktree);
    return { jobSlug, root, baseWorktree, baseBranch, inherited };
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
   * matches any preserved work — the user needn't retype the original request — and among those, the one with
   * ACTUAL PROGRESS wins over the merely most recent. Otherwise the prompt must match a checkpoint's stored
   * `rawPrompt` (case/space-tolerant). Returns null when there is nothing to resume.
   */
  async findResumable(rawPrompt: string): Promise<WorktreeSession | null> {
    const worktreesDir = join(this.worktreeHome, ".horsecode", "worktrees");
    if (!existsSync(worktreesDir)) return null;
    // ensureRepo would be needed for the git call below, but if there's a worktrees dir there's already a repo.
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"], this.repoRoot);
    if (inside.code !== 0) return null;
    const anyContinue = isContinuePrompt(rawPrompt);
    const key = checkpointKey(rawPrompt);
    const registered = await this.registeredWorktrees();
    const candidates: { session: WorktreeSession; mtime: number; progress: number }[] = [];
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
      candidates.push({
        session: { jobSlug: slug, root, baseWorktree, baseBranch: `hc/${slug}/base`, resumed: true },
        mtime: checkpointMtime(root),
        progress: cp.done.length,
      });
    }
    if (candidates.length === 0) return null;
    // Progress FIRST, recency second. Ranking by recency alone let an empty worktree — one that finished no
    // phase at all — outrank the real work simply because it was touched later, and "continue" would then
    // restart the pipeline from the constitution while a spec'd, committed feature sat next to it untouched.
    candidates.sort((a, b) => (b.progress > 0 ? 1 : 0) - (a.progress > 0 ? 1 : 0) || b.mtime - a.mtime);
    const picked = candidates[0].session;
    /**
     * A resumed session still holds the project as it was on the day it was opened.
     *
     * Inheritance runs once, at openSession. Measured on a real project: the worktree was cut before a
     * constitution existed, the user then wrote one, resumed the job — and the run announced "No `.specify/`
     * directory exists yet" and started a second one, with the first thirty-two kilobytes away in the root.
     * Only what is missing is filled in; anything the session already has is its own work.
     */
    const added = await topUpInherited(this.repoRoot, picked.baseWorktree);
    return added.length ? { ...picked, toppedUp: added } : picked;
  }

  /**
   * The worktree for a task — REUSED when the task already has one.
   *
   * It used to mint a fresh slug every time, so a task got `…-1`, `…-2`, `…-9` and each run began from base
   * with the previous run's work stranded in a directory nobody would open again. Measured live: 321
   * worktrees on disk, TEN of them for one task, and the newest empty while `…-9` held 8 commits and 7.6 KB
   * of finished work.
   *
   * It also made the pipeline lie. The deadline warning tells the implementer "whatever it wrote is committed
   * and kept — continue from there rather than starting over", and across runs that was simply false: a task
   * needing more than one run's worth of work could never accumulate any.
   *
   * A fresh slug is still minted when the existing directory is not a usable worktree for this task's branch,
   * because a broken one must not stop the task.
   */
  async deriveTask(session: WorktreeSession, taskName: string): Promise<TaskWorktree> {
    const tasksDir = join(session.root, "tasks");
    const slug = toSlug(taskName);
    const branch = `hc/${session.jobSlug}/t/${slug}`;
    const existing = join(tasksDir, slug);
    if (existsSync(existing)) {
      // `rev-parse` is the cheapest question that distinguishes a live worktree from a leftover directory.
      const ok = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], existing);
      if (ok.code === 0 && ok.stdout.trim() === branch) return { taskSlug: slug, worktree: existing, branch };
    }
    const taskSlug = uniqueSlug(slug, (s) => existsSync(join(tasksDir, s)));
    const wt = join(tasksDir, taskSlug);
    const br = `hc/${session.jobSlug}/t/${taskSlug}`;
    await this.run(["worktree", "add", "-b", br, wt, session.baseBranch], this.repoRoot);
    return { taskSlug, worktree: wt, branch: br };
  }

  /**
   * Retires a task's worktree and branch so the next derive starts from the CURRENT base.
   *
   * Reusing a task's worktree between attempts stopped the "start from scratch every run" waste, but it also
   * FROZE the branch's root. Measured on a real board: the export/import task's branch was rooted two and a
   * half days back and the base had moved 68 commits past it, while the throwaway worktrees it replaced had
   * been rooted 29-30 commits back. Its merge then had to reconcile a drift that wide across seven files, and
   * the resolver ran out of turns every time — twice on a review that had already PASSED.
   *
   * Past a few of those, re-implementing on today's base is cheaper than reconciling the drift, and it is the
   * only move that actually removes the cause.
   *
   * The old branch is RENAMED, not deleted. It holds work that passed review; throwing it away to save a
   * branch name would destroy the only copy of it.
   */
  async restartTask(session: WorktreeSession, task: TaskWorktree): Promise<string> {
    let retired = `${task.branch}-stale`;
    for (let n = 2; (await this.git(["rev-parse", "--verify", "--quiet", retired], this.repoRoot)).code === 0; n++) {
      retired = `${task.branch}-stale-${n}`;
    }
    // Force: the worktree holds the attempt's own commits and, after a failed merge, possibly a dirty tree.
    await this.run(["worktree", "remove", "--force", task.worktree], this.repoRoot);
    await this.run(["branch", "-m", task.branch, retired], this.repoRoot);
    return retired;
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

  /**
   * Resolves one conflicted path by taking the BASE's copy, for files that are regenerated rather than merged.
   *
   * `--ours` during a merge means the branch being merged INTO — the session base, where the other tasks'
   * work has already landed. For a lockfile that is the right side: it already carries every dependency the
   * merged tasks installed, and the incoming branch's own addition is re-derived by running the package
   * manager, not by choosing lines from a machine-written file.
   */
  async resolveWithBase(session: WorktreeSession, file: string): Promise<void> {
    await this.git(["checkout", "--ours", "--", file], session.baseWorktree);
    await this.git(["add", "--", file], session.baseWorktree);
  }

  /** Unified diff of changes in the base worktree against the base branch (the PR diff). */
  /**
   * The code first, then what was written about it.
   *
   * Git orders a diff by path, so on a run whose work lives under `toucan/` every specification, plan,
   * checklist and brainstorm sorts ahead of the source. Measured on PR #765 with horse-code's own state
   * already excluded: the first 60,000 characters held nine files, all of them markdown, and not one line of
   * the code the review existed to read. Ordering is the fix — a budget spent on prose is a budget the
   * source never sees, however large it is.
   */
  async diff(session: WorktreeSession, base: string): Promise<string> {
    const range = `${base}...${session.baseBranch}`;
    const notDocs = DOC_SPECS.map((d) => `:(exclude)${d}`);
    const code = await this.git(["diff", range, "--", ".", ...excludeOwnState(), ...notDocs], session.baseWorktree);
    const docs = await this.git(["diff", range, "--", ...DOC_SPECS, ...excludeOwnState()], session.baseWorktree);
    const out = code.stdout + docs.stdout;
    if (out.length <= MAX_DIFF_CHARS) return out;
    /**
     * Said at the TOP, because a reviewer reads from the top and stops where the text stops.
     *
     * The note used to be appended, where the reader never reaches it — so a truncated diff looked like a
     * complete one, and a round's findings were written about the only files that fitted.
     */
    return `… (diff truncated to the first ${MAX_DIFF_CHARS} characters of ${out.length}; `
      + `use the read tools to inspect anything not shown here)\n${out.slice(0, MAX_DIFF_CHARS)}`;
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

  /**
   * Renames a session to match the work it turned out to be.
   *
   * A session is named from the FIRST request that needed a worktree, and the first request is often the
   * smallest: reported live, a sitting whose real work was product-upload testing sat in
   * `hc/turkish-agent-communications/base`, named after a one-line rule someone asked for on the way in.
   * The name is what a person reads in `git worktree list` a week later, so it should describe the work,
   * not the doorway.
   *
   * Refused once the branch has a remote: a rename would orphan a pushed branch and any pull request cut
   * from it. Refused too when the target is taken, and when nothing would change. Returns the session as it
   * now stands, renamed or not — callers must use the result, because the paths inside it have moved.
   */
  async renameSession(session: WorktreeSession, name: string): Promise<WorktreeSession> {
    // The INPUT decides, not the slug: `toSlug` answers "job" for anything it cannot read, and renaming a
    // session to `hc/job/base` because the hint was blank is worse than leaving the name it had.
    if (!name.trim()) return session;
    const want = toSlug(name);
    if (want === session.jobSlug) return session;
    const pushed = await this.git(["rev-parse", "--verify", "--quiet", `${session.baseBranch}@{upstream}`], this.repoRoot);
    if (pushed.code === 0) return session;   // …already published under its current name
    const worktreesDir = join(this.worktreeHome, ".horsecode", "worktrees");
    const listed = await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/hc/"], this.repoRoot);
    const branches = new Set(listed.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
    if (existsSync(join(worktreesDir, want)) || branches.has(`hc/${want}/base`)) return session;

    const root = join(worktreesDir, want);
    const baseWorktree = join(root, "base");
    const baseBranch = `hc/${want}/base`;
    // `git worktree move` will not create the destination's parent, and the new session directory is one.
    await mkdir(root, { recursive: true });
    // The directory first: `git worktree move` rewrites git's own record of where the checkout lives, and a
    // branch renamed before it would leave that record pointing at a path under the old name.
    const moved = await this.git(["worktree", "move", session.baseWorktree, baseWorktree], this.repoRoot);
    if (moved.code !== 0) await rm(root, { recursive: true, force: true }).catch(() => { /* leave nothing behind */ });
    if (moved.code !== 0) return session;    // …in use, or git refused: the old name is not worth a broken session
    const renamed = await this.git(["branch", "-m", session.baseBranch, baseBranch], this.repoRoot);
    if (renamed.code !== 0) {
      await this.git(["worktree", "move", baseWorktree, session.baseWorktree], this.repoRoot); // put it back
      return session;
    }
    // The session's own directory carries the rest — the board, the checkpoint, the task worktrees' parent.
    for (const rest of ["board.json", "checkpoint.json", "tasks"]) {
      const from = join(session.root, rest);
      if (existsSync(from)) await rename(from, join(root, rest)).catch(() => { /* best-effort */ });
    }
    await rm(session.root, { recursive: true, force: true }).catch(() => { /* the empty shell */ });
    return { ...session, jobSlug: want, root, baseWorktree, baseBranch };
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

  /** Whether a remote exists — the difference between a pull request being delivery and being impossible. */
  async hasRemote(session: WorktreeSession, remote = "origin"): Promise<boolean> {
    return (await this.git(["remote", "get-url", remote], session.baseWorktree)).code === 0;
  }

  async push(session: WorktreeSession, remote = "origin"): Promise<void> {
    const check = await this.git(["remote", "get-url", remote], session.baseWorktree);
    if (check.code !== 0) return; // no remote → local-only, skip push
    await this.run(["push", remote, session.baseBranch], session.baseWorktree);
  }

  /**
   * Lands the finished work on the branch the job started from, in the main working copy.
   *
   * Without this, a project with no git remote gets nothing: `push` is a no-op and a pull request has
   * nowhere to go, so every completed task sits on `hc/<job>/base` — invisible from the repository root.
   * A user who watched thirty tasks succeed then finds an empty directory and cannot run the project.
   *
   * A pull request is delivery when there is a remote to open it against. When there is not, merging is.
   *
   * Refuses rather than forces. A dirty working copy or a checkout on some other branch means the user has
   * something in progress, and overwriting that to deliver would be a worse failure than not delivering:
   * the branch still exists and the caller reports how to merge it by hand.
   */
  async deliverLocally(session: WorktreeSession, targetBranch: string): Promise<
    { ok: true; commits: number } | { ok: false; why: string }
  > {
    const dirty = await this.git(["status", "--porcelain"], this.repoRoot);
    if (dirty.code !== 0) return { ok: false, why: "the repository could not be read" };
    if (dirty.stdout.split("\n").some((l) => l.trim() && !l.startsWith("??"))) {
      return { ok: false, why: "the working copy has uncommitted changes" };
    }
    const head = await this.git(["symbolic-ref", "--short", "HEAD"], this.repoRoot);
    const current = head.stdout.trim();
    if (head.code !== 0 || !current) return { ok: false, why: "the repository is not on a branch" };
    if (current !== targetBranch) return { ok: false, why: `the repository is on \`${current}\`, not \`${targetBranch}\`` };

    const count = await this.git(["rev-list", "--count", `${targetBranch}..${session.baseBranch}`], this.repoRoot);
    const commits = Number(count.stdout.trim()) || 0;
    if (!commits) return { ok: true, commits: 0 }; // already contains it — nothing to do, and not a failure

    // --no-ff keeps the job visible as one merge; a fast-forward would scatter hundreds of task commits
    // into the branch with no record of what they belonged to.
    const merged = await this.git(
      ["merge", "--no-ff", "-m", `hc: ${session.jobSlug}`, session.baseBranch], this.repoRoot);
    if (merged.code !== 0) return { ok: false, why: "the merge did not apply cleanly" };
    return { ok: true, commits };
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
