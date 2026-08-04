import { Board } from "../board/board.js";
import { runTaskCycle } from "./task-cycle.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { ReviewDeps } from "./review.js";
import type { Finding } from "./finding.js";

/**
 * Fixing something found while testing, without buying the machinery for discovering it.
 *
 * The pipeline's upstream half — constitution, brainstorm, spec, clarify, plan, tasks — exists to work out
 * WHAT to build. For a finding at `task` depth that question is already answered: someone watched the screen,
 * saw what was wrong, and said what should have happened instead. Running a spec and a plan over that is
 * paying to discover what is already known.
 *
 * The downstream half is a different matter and is kept in full: an implementer writes it, a code reviewer
 * reads it, and the acceptance gate checks it against what was actually asked. Skipping design is right
 * because there is nothing to design; skipping review would only mean nobody read the change — and this one
 * lands in a pull request that is already open.
 *
 * IN PLACE, on the branch the developer is standing on. Not a preference: their environment is serving THAT
 * working tree, so a fix made in a worktree copy is one they cannot see and cannot re-test. The whole point
 * is to fold it back into the verification.
 */

/** A card is how the rest of the system talks about a piece of work; a finding becomes one. */
export function cardFromFinding(f: Finding, id: string): {
  id: string; title: string; acceptance: string[]; files: string[];
} {
  return {
    id,
    title: f.title,
    /**
     * Its own acceptance criteria, with a floor.
     *
     * The gate can only check what it was given, so a finding reported without criteria would pass by having
     * been attempted. The detail is what the person actually saw, which is the one statement that is always
     * true of a real fix: that is no longer what happens.
     */
    acceptance: f.acceptance.length ? f.acceptance : [`No longer happens: ${f.detail}`],
    files: f.files,
  };
}

export interface FixResult {
  title: string;
  fixed: boolean;
  /** Why not, when it did not — the reviewer's notes, or that nothing was written. */
  notes: string[];
}

/**
 * Runs one finding through implement → review → acceptance, in the working tree.
 *
 * Never throws. A verification that stops because a fix went wrong has lost the more valuable thing: the
 * scenarios already run and the evidence already gathered.
 */
export async function runFix(
  deps: ReviewDeps, workdir: string, f: Finding, id = "fix-1",
): Promise<FixResult> {
  try {
    const board = new Board();
    board.addCard(cardFromFinding(f, id));
    const verdict = await runTaskCycle(deps, board, id, workdir);
    return {
      title: f.title,
      fixed: verdict.verdict === "pass",
      notes: verdict.verdict === "pass" ? [] : (verdict.noProgress ? ["nothing was written"] : verdict.notes),
    };
  } catch (e) {
    return { title: f.title, fixed: false, notes: [e instanceof Error ? e.message : String(e)] };
  }
}

/** Repo-relative paths with any uncommitted change right now — the tree as it stood before the work. */
export async function dirtyPaths(git: GitRunner, cwd: string): Promise<Set<string>> {
  const r = await git(["status", "--porcelain"], cwd);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean));
}

/**
 * Commits exactly what changed while the work was being done, and nothing else.
 *
 * `git add -A` was the obvious thing, and it is wrong the moment a commit happens without being asked for. A
 * working tree is never only the change: a session leaves `.horsecode/memory.jsonl` modified, a verification
 * leaves a half-written report beside it, and the developer has their own edits in progress. Sweeping those
 * into a commit titled after a one-line fix is how someone's work disappears under a message that does not
 * mention it.
 *
 * A file that was ALREADY dirty is left out even when the work touched it too: there is no way to take the
 * work's half without taking the developer's. That one is theirs to sort out, and they can see it.
 */
export async function commitOnly(
  git: GitRunner, cwd: string, before: Set<string>, message: string,
): Promise<boolean> {
  const after = await dirtyPaths(git, cwd);
  const mine = [...after].filter((p) => !before.has(p));
  if (!mine.length) return false;
  const add = await git(["add", "--", ...mine], cwd);
  if (add.code !== 0) return false;
  const staged = await git(["diff", "--cached", "--quiet", "--", ...mine], cwd);
  if (staged.code === 0) return false;
  const r = await git(["commit", "-m", message, "--", ...mine], cwd);
  return r.code === 0;
}

/**
 * Commits a fix on its own, taking only what the fix wrote.
 *
 * Separately from the report, because they are different things and the pull request should show them as
 * such: one commit changes the product, the other records what was observed of it.
 */
export async function commitFix(workdir: string, f: Finding, before: Set<string>): Promise<boolean> {
  return commitOnly(defaultGitRunner, workdir, before, `fix: ${f.title}`);
}

/** What the user is told after each one. */
export function describeFix(r: FixResult): string {
  return r.fixed
    ? `🔧 Fixed: **${r.title}** — implemented, reviewed, and checked against what the finding asked for.`
    : `⚠️ Not fixed: **${r.title}**${r.notes.length ? ` — ${r.notes.slice(0, 3).join("; ")}` : ""}. `
      + `It stays in the report as an open finding.`;
}

/**
 * A small change, done where the user is standing.
 *
 * The same cycle a finding gets — implement, review, check against what was asked — with the acceptance
 * criteria coming from the sizing call rather than from a person watching a screen. No worktree and no pull
 * request: a branch exists to hold work that needs reviewing as a unit before it lands, and this already had
 * its review.
 */
export async function runSmallChange(
  deps: ReviewDeps, workdir: string, title: string, prompt: string,
  spec: { acceptance: string[]; files: string[] },
): Promise<FixResult & { committed: boolean }> {
  const before = await dirtyPaths(defaultGitRunner, workdir);
  let res: FixResult;
  try {
    const board = new Board();
    /**
     * A floor under the acceptance criteria.
     *
     * The sizing produces them, but a request the developer themselves called small — after being asked —
     * can arrive without any. The gate can only check what it was given, so the request itself becomes the
     * criterion: weak, but honest, and the code review still runs over the change.
     */
    const acceptance = spec.acceptance.length ? spec.acceptance : [`The request is satisfied: ${prompt}`];
    board.addCard({ id: "small-1", title: prompt, acceptance, files: spec.files });
    const verdict = await runTaskCycle(deps, board, "small-1", workdir);
    res = {
      title,
      fixed: verdict.verdict === "pass",
      notes: verdict.verdict === "pass" ? [] : (verdict.noProgress ? ["nothing was written"] : verdict.notes),
    };
  } catch (e) {
    res = { title, fixed: false, notes: [e instanceof Error ? e.message : String(e)] };
  }
  const committed = res.fixed ? await commitOnly(defaultGitRunner, workdir, before, prompt) : false;
  return { ...res, committed };
}

/** What the user is told after a small change. */
export function describeSmallChange(
  r: FixResult & { committed: boolean }, reason: string, branch: string,
): string {
  if (!r.fixed) {
    return `⚠️ Not done: ${r.notes.join("; ") || "the change did not pass review"}.\n\n`
      + `Nothing was committed. Ask again with more detail, or say so and I will treat it as a full piece of work.`;
  }
  return `✅ Done — implemented, reviewed, and checked against what was asked.\n\n`
    + `_Handled as a small change (${reason}): no branch, no spec, no plan._ `
    + (r.committed
      ? `Committed on \`${branch}\`.`
      : `Nothing was left to commit — the working tree already had it.`);
}
