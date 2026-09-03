import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import { commitFile } from "./operational.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * What an attempt actually changed, asked of git rather than inferred from tool calls.
 *
 * `onWrite` fires for `write_file` and `edit_file`, and those are not the only ways a file reaches the tree.
 * A `shell` call that runs a generator, a formatter, `npm init`, a migration tool — every file it produces is
 * invisible to the record: never credited to the memory that predicted it, and never committed, so an attempt
 * stopped at its deadline loses exactly the work a tool did not personally write.
 *
 * It is also what makes a DELEGATED implementer work at all. When the agent is an official CLI running in the
 * worktree with its own tools, no `onWrite` ever fires — the writes happen in another process. Asking git is
 * the one question whose answer is the same whichever agent did the work, which is why the reconciliation
 * lives here rather than in either path.
 */

/** Repo-relative paths git reports as changed — added, modified, renamed or untracked. */
export async function changedPaths(cwd: string, git: GitRunner = defaultGitRunner): Promise<string[]> {
  const res = await git(["status", "--porcelain", "-uall"], cwd);
  if (res.code !== 0) return [];
  const out: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: two status characters, a space, then the path. A rename is `R  old -> new`; the NEW
    // path is the one that exists, and the one a memory anchored to a file should be credited against.
    const path = line.slice(3).trim();
    const arrow = path.lastIndexOf(" -> ");
    const p = arrow >= 0 ? path.slice(arrow + 4) : path;
    // Quoted when it contains anything unusual; the quotes are git's, not the name's.
    out.push(p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
  }
  return out;
}

/**
 * Folds whatever git says changed into `touched`, committing anything no tool checkpointed.
 *
 * Returns the paths this added, so a caller can say how much of the work arrived by a route the tool layer
 * could not see. Never throws: a reconciliation that fails must not fail the attempt that produced the work.
 */
export async function reconcileTouched(
  deps: TaskCycleDeps, cwd: string, touched: string[], git: GitRunner = defaultGitRunner,
): Promise<string[]> {
  let changed: string[];
  try { changed = await changedPaths(cwd, git); } catch { return []; }
  const known = new Set(touched);
  const extra = changed.filter((p) => !known.has(p));
  for (const p of extra) {
    touched.push(p);
    // Checkpointed for the same reason a tool write is: an attempt stopped at its deadline keeps what it did.
    try { await commitFile(deps, cwd, p, git); } catch { /* best-effort — the path is still credited */ }
  }
  return extra;
}
