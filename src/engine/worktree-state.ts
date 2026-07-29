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
