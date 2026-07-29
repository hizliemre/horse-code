import type { GitRunner } from "../worktree/git.js";

/**
 * A fingerprint of the worktree: its HEAD and everything git can see that is not committed.
 *
 * Its own module because two callers need the SAME check and neither may import the other — the normal
 * implement/review cycle and the escalation council. The council did not have one: its senior implementation
 * moved to REVIEW whatever happened. Measured live — five tasks each ran a council implementation of one turn
 * and ZERO tool calls, went to review with an unchanged worktree, and the reviewer spent all 25 of its turns
 * hunting for a change that was not there before failing with "tool call budget exceeded before review could
 * be conducted". Every one of those reviews was pure cost: there was nothing to judge.
 *
 * `undefined` when git cannot answer — the callers skip the check rather than guess, because a false
 * "nothing changed" would throw away real work.
 */
export async function worktreeState(git: GitRunner, cwd: string): Promise<string | undefined> {
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const status = await git(["status", "--porcelain"], cwd);
  return `${head.stdout.trim()}|${status.stdout.trim()}`;
}

/**
 * Whether the worktree holds ANY work relative to the branch it came from.
 *
 * The question that matters before a review is not "did this attempt add something" but "is there anything
 * to judge". A retried task carries its earlier work in its worktree, so a senior that looks, sees the job
 * already done and writes nothing is making a correct observation — not failing.
 *
 * Treating those as failures did real damage: it recorded strikes against `cc/claude-opus-4-8` and benched it
 * from `senior-coder` on 2 of 2, for declining to rewrite code that was already there.
 */
export async function hasWorkAgainst(git: GitRunner, cwd: string, baseRef: string): Promise<boolean> {
  const merge = await git(["merge-base", "HEAD", baseRef], cwd);
  const at = merge.stdout.trim();
  if (merge.code !== 0 || !at) return false; // cannot tell → the caller falls back to its own check
  const diff = await git(["diff", "--quiet", `${at}..HEAD`], cwd);
  if (diff.code !== 0) return true;          // committed work
  const dirty = await git(["status", "--porcelain"], cwd);
  return dirty.stdout.trim().length > 0;     // uncommitted work
}
