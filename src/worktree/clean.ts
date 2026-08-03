import { rm } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "./git.js";

/**
 * Removing the sessions whose work has already landed.
 *
 * A finished run leaves a directory and a branch per task behind. Nothing collects them: `closeSession` runs
 * when a job ends cleanly, and a run that was interrupted, parked or delivered as a pull request never gets
 * there. Measured on a real project, ONE session had accumulated seventeen live worktrees — a base and
 * sixteen tasks — each a full checkout of the repository.
 *
 * The judgement this makes is narrow on purpose. "Merged" is the only thing it will act on, because it is the
 * only state where deleting is provably not a loss: the commits exist on the target branch, so the worktree
 * holds nothing that is not already somewhere safer.
 */

export const SESSIONS_DIR = join(".horsecode", "worktrees");

export type Verdict =
  /** Every commit is on the target branch and no file is uncommitted — safe to remove. */
  | "merged"
  /** Carries commits the target does not have. Removing it would throw work away. */
  | "unmerged"
  /** Merged, but a worktree has uncommitted changes — the commits are safe, the edits are not. */
  | "dirty"
  /** A directory git does not know about: no registered worktree, so its state cannot be judged. */
  | "orphan";

export interface SessionSurvey {
  slug: string;
  /** `.horsecode/worktrees/<slug>` — absolute. */
  root: string;
  baseBranch: string;
  /** Registered worktree paths under this session, base first. */
  worktrees: string[];
  branches: string[];
  verdict: Verdict;
  /** Why, in the terms the user needs to decide — never just the verdict again. */
  detail: string;
}

/** Absolute worktree paths git currently tracks. */
async function registered(git: GitRunner, repoRoot: string): Promise<string[]> {
  const r = await git(["worktree", "list", "--porcelain"], repoRoot);
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    try { out.push(realpathSync(p)); } catch { out.push(p); }
  }
  return out;
}

/**
 * Whether `branch` carries anything the target does not already have.
 *
 * Two questions, because there are two ways work arrives. Ancestry answers the ordinary merge. It does NOT
 * answer a squash merge, which is what most pull request platforms do by default: the target gets ONE commit
 * whose hash and whose patch id differ from every commit on the branch, so the branch is not an ancestor and
 * `git branch --merged` will never list it. A command that asked only the first question would sit there
 * doing nothing, forever, on exactly the workflow that leaves the most worktrees behind.
 *
 * The second question is asked the way git's own documentation suggests: build a throwaway commit carrying
 * the branch's TREE on top of the merge base, and ask whether its patch is already upstream. A squashed merge
 * produced exactly that patch, so `git cherry` recognises it. (The throwaway commit is never referenced, so
 * it is unreachable the moment this returns and gc collects it.)
 */
export async function isMerged(
  git: GitRunner, repoRoot: string, branch: string, target: string,
): Promise<boolean> {
  const ancestor = await git(["merge-base", "--is-ancestor", branch, target], repoRoot);
  if (ancestor.code === 0) return true;

  const mb = await git(["merge-base", target, branch], repoRoot);
  if (mb.code !== 0 || !mb.stdout.trim()) return false;
  const tree = await git(["rev-parse", `${branch}^{tree}`], repoRoot);
  if (tree.code !== 0 || !tree.stdout.trim()) return false;
  const squashed = await git(
    ["commit-tree", tree.stdout.trim(), "-p", mb.stdout.trim(), "-m", "hc: squash-merge probe"], repoRoot);
  if (squashed.code !== 0 || !squashed.stdout.trim()) return false;
  const cherry = await git(["cherry", target, squashed.stdout.trim()], repoRoot);
  if (cherry.code !== 0) return false;
  // `git cherry` prefixes a commit already upstream with "-", one that is not with "+".
  return cherry.stdout.trim().startsWith("-");
}

/** Repo-relative paths of everything uncommitted in a worktree, or [] when it is clean or unreadable. */
async function uncommitted(git: GitRunner, worktree: string): Promise<string[]> {
  const r = await git(["status", "--porcelain"], worktree);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
}

/**
 * What is on disk, and what may be done with each of it.
 *
 * Looks only inside `.horsecode/worktrees`. Another tool's checkouts — `.claude/worktrees` is the one that
 * shows up in practice — are somebody else's working copies, and a command that cleans up after horse-code
 * has no business deciding they are finished.
 */
export async function surveySessions(
  git: GitRunner, repoRoot: string, target: string,
): Promise<SessionSurvey[]> {
  const dir = join(repoRoot, SESSIONS_DIR);
  if (!existsSync(dir)) return [];
  const slugs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!slugs.length) return [];

  const live = await registered(git, repoRoot);
  const listed = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/hc/"], repoRoot);
  const allBranches = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const out: SessionSurvey[] = [];
  for (const slug of slugs) {
    const root = join(dir, slug);
    let real = root;
    try { real = realpathSync(root); } catch { /* the path as given is the best available */ }
    const worktrees = live.filter((p) => p === real || p.startsWith(`${real}/`))
      .sort((a, b) => a.length - b.length);   // the base is the shortest path under the root
    const branches = allBranches.filter((b) => b === `hc/${slug}/base` || b.startsWith(`hc/${slug}/`));
    const baseBranch = `hc/${slug}/base`;
    const row = { slug, root, baseBranch, worktrees, branches };

    if (!worktrees.length) {
      out.push({ ...row, verdict: "orphan",
        detail: "git no longer tracks a worktree here — what it held cannot be checked, so it is left alone." });
      continue;
    }
    if (!branches.includes(baseBranch)) {
      out.push({ ...row, verdict: "orphan", detail: `its branch \`${baseBranch}\` is gone — nothing to judge it by.` });
      continue;
    }
    if (!(await isMerged(git, repoRoot, baseBranch, target))) {
      const ahead = await git(["rev-list", "--count", `${target}..${baseBranch}`], repoRoot);
      const n = ahead.code === 0 ? ahead.stdout.trim() : "?";
      out.push({ ...row, verdict: "unmerged", detail: `${n} commit(s) not in \`${target}\` — removing it would lose them.` });
      continue;
    }
    // Merged says the COMMITS are safe. It says nothing about a file someone is part-way through editing.
    const dirty: string[] = [];
    for (const w of worktrees) {
      const files = await uncommitted(git, w);
      if (files.length) dirty.push(`${w.slice(root.length + 1) || "base"} (${files.length})`);
    }
    if (dirty.length) {
      out.push({ ...row, verdict: "dirty", detail: `merged, but uncommitted changes remain in ${dirty.join(", ")}.` });
      continue;
    }
    out.push({ ...row, verdict: "merged",
      detail: `every commit is in \`${target}\` and nothing is uncommitted — ${worktrees.length} worktree(s), ${branches.length} branch(es).` });
  }
  return out;
}

export interface CleanResult {
  removed: string[];
  /** Sessions that were removable but whose removal failed, with why. */
  failed: { slug: string; error: string }[];
  kept: SessionSurvey[];
}

/**
 * Removes the merged sessions, and only those.
 *
 * `git worktree remove` is asked first so git's own bookkeeping goes away with the files; the directory is
 * then removed outright, because a worktree git has already forgotten leaves one behind. `worktree prune`
 * afterwards clears any record of a path that no longer exists.
 */
export async function cleanSessions(
  git: GitRunner, repoRoot: string, target: string,
): Promise<CleanResult> {
  const survey = await surveySessions(git, repoRoot, target);
  const out: CleanResult = { removed: [], failed: [], kept: survey.filter((s) => s.verdict !== "merged") };

  for (const s of survey.filter((x) => x.verdict === "merged")) {
    try {
      // Longest path first: a task worktree lives inside the base's directory tree, and removing the parent
      // first would leave git holding a record of a child that is no longer there.
      for (const w of [...s.worktrees].sort((a, b) => b.length - a.length)) {
        await git(["worktree", "remove", "--force", w], repoRoot);
      }
      await rm(s.root, { recursive: true, force: true });
      await git(["worktree", "prune"], repoRoot);
      for (const b of s.branches) await git(["branch", "-D", b], repoRoot);
      out.removed.push(s.slug);
    } catch (e) {
      out.failed.push({ slug: s.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const MARK: Record<Verdict, string> = { merged: "🧹", unmerged: "⏳", dirty: "✋", orphan: "❓" };

/** What the user reads BEFORE anything is deleted — every session, its verdict, and the reason for it. */
export function describeSurvey(survey: SessionSurvey[], target: string): string {
  if (!survey.length) return "No horse-code worktrees — `.horsecode/worktrees` is empty or absent.";
  const rows = survey.map((s) => `${MARK[s.verdict]} \`${s.slug}\` — ${s.detail}`);
  const removable = survey.filter((s) => s.verdict === "merged");
  const head = `Judged against \`${target}\`:`;
  const tail = removable.length
    ? `\n\n\`/clean-worktrees go\` removes ${removable.length === 1 ? "it" : `the ${removable.length} marked 🧹`}`
      + ` — directories and branches together. Everything else is left as it is.`
    : `\n\nNothing to remove.`;
  return `${head}\n${rows.join("\n")}${tail}`;
}

/** What the user reads after. */
export function describeClean(res: CleanResult, target: string): string {
  const bits: string[] = [];
  if (res.removed.length) bits.push(`🧹 Removed ${res.removed.length} merged session(s): ${res.removed.map((s) => `\`${s}\``).join(", ")}.`);
  else bits.push(`Nothing was merged into \`${target}\` — nothing removed.`);
  if (res.failed.length) bits.push(`⚠️ Could not remove ${res.failed.map((f) => `\`${f.slug}\` (${f.error})`).join(", ")}.`);
  if (res.kept.length) bits.push(`Kept: ${res.kept.map((s) => `\`${s.slug}\` (${s.verdict})`).join(", ")}.`);
  return bits.join("\n\n");
}
