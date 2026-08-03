import { Board } from "../board/board.js";
import { runTaskCycle } from "./task-cycle.js";
import { defaultGitRunner } from "../worktree/git.js";
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

/**
 * Commits the fix on its own.
 *
 * Separately from the report, because they are different things and the pull request should show them as
 * such: one commit changes the product, the other records what was observed of it.
 */
export async function commitFix(workdir: string, f: Finding): Promise<boolean> {
  const git = defaultGitRunner;
  const add = await git(["add", "-A"], workdir);
  if (add.code !== 0) return false;
  const staged = await git(["diff", "--cached", "--quiet"], workdir);
  if (staged.code === 0) return false; // nothing changed — not a failure, just nothing to record
  const r = await git(["commit", "-m", `fix: ${f.title}`], workdir);
  return r.code === 0;
}

/** What the user is told after each one. */
export function describeFix(r: FixResult): string {
  return r.fixed
    ? `🔧 Fixed: **${r.title}** — implemented, reviewed, and checked against what the finding asked for.`
    : `⚠️ Not fixed: **${r.title}**${r.notes.length ? ` — ${r.notes.slice(0, 3).join("; ")}` : ""}. `
      + `It stays in the report as an open finding.`;
}
