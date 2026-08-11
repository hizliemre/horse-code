import type { GitRunner } from "../worktree/git.js";
import { defaultGitRunner } from "../worktree/git.js";
import { excludeOwnState } from "../worktree/manager.js";

/**
 * How much of a task's diff a reviewer is handed.
 *
 * Generous — the point is that the reviewer never has to go looking — but finite: the diff rides in the
 * prompt of every review round, and an unbounded one would be re-sent on each of them.
 */
export const MAX_DIFF_CHARS = 60_000;

/**
 * What this task actually changed, as a diff against the branch it was derived from.
 *
 * Reviewers used to be told "review the code that implements X" and handed read/grep/glob to go and find it.
 * Measured on a real board, that is where they died: `Tool-call budget was exhausted prior to inspecting code
 * changes`, `No code inspection was performed`, `I cannot complete an evidence-based review` — over and over,
 * each one recorded as a REJECTION, each rejection escalating the task a tier until it was abandoned. Four of
 * the six schedulable tasks on that board were dead this way, and none of them for anything to do with the
 * code.
 *
 * A reviewer's subject is the change. Handing it over costs one git call and removes the search entirely.
 */
/**
 * …and never our own bookkeeping, which is the one thing guaranteed to be in it.
 *
 * `excludeOwnState` was written for the PULL REQUEST diff, after PR #765 handed a reviewer 60,000 characters
 * holding exactly two files — `.gitignore` and `.horsecode/memory.jsonl` — while all 36 source files fell
 * outside the budget. The TASK diff, which every lens, the council and the acceptance gate read, was left
 * asking the same question the same way.
 *
 * Measured, one door over, on the run that produced this: the gate reported "the diff visible in the prompt
 * is entirely memory.jsonl metadata changes (injection counters). The actual Angular/HTML template changes
 * that this task requires were in the truncated portion of the diff, and no source file was opened to
 * verify." It then failed 6 of 6 criteria and 31 minutes of work was thrown away — over a file the work never
 * touched. `.horsecode/` sorts almost first alphabetically, so this is not bad luck; it is where it always is.
 */
export async function taskDiff(
  cwd: string,
  baseRef: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  // Three dots: what THIS branch added since it forked, not everything that has landed on base meanwhile.
  const out = await git(["diff", `${baseRef}...HEAD`, "--", ".", ...excludeOwnState()], cwd);
  if (out.code !== 0) return "";
  const diff = out.stdout;
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n…diff truncated at ${MAX_DIFF_CHARS} characters — read the remaining files directly.`;
}

/** The diff as a prompt section, or an explicit note that there wasn't one. */
export function describeDiff(diff: string): string {
  if (!diff.trim()) {
    return "The diff for this task could not be produced. Inspect the worktree with read_file/grep instead.";
  }
  return `The complete diff of this task's changes follows. It is the subject of the review — read it first, ` +
    `and open a file only when the diff alone cannot answer a question.\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

/**
 * What the working tree holds that HEAD does not — the change when there is no branch to compare against.
 *
 * `taskDiff` compares commits, and the small-change path never makes one until the work is accepted: it edits
 * the tree in place. So it asked for a diff, got nothing, and `lensesFor` fell back to the whole team on the
 * grounds that an unknown size could be anything. Measured live: `hc.task.id: "small-1"`,
 * `hc.changed_lines: 0`, `hc.lenses: 15` — the one path built to be cheap convened every reviewer there is,
 * nine of them ran past their budget, and the round committed nothing after 41 minutes.
 */
export async function workingTreeDiff(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  // `HEAD` rather than the index: staged and unstaged edits are both part of what is being reviewed.
  const out = await git(["diff", "HEAD", "--", ".", ...excludeOwnState()], cwd);
  if (out.code !== 0) return "";
  const diff = out.stdout;
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n…diff truncated at ${MAX_DIFF_CHARS} characters — read the remaining files directly.`;
}

/**
 * Everything that has happened here since a point in time — commits AND the tree that is not committed yet.
 *
 * `workingTreeDiff` was written on a premise that is false: "the small-change path never makes a commit until
 * the work is accepted". Every file an implementer writes is auto-committed as a `wip(…)` checkpoint the
 * moment it is written — that is what lets a killed attempt keep its work — so by the time the review runs,
 * the change is in commits and the tree is clean.
 *
 * Measured live, and it cost the whole run: a coder fixed the drag preview, its five files went into
 * `wip(chore/media): product-media-manager.html` and friends, and the reviewer was handed `git diff HEAD` —
 * which by then held one line of `.horsecode/memory.jsonl`. `code-plan-conformance` read exactly what it was
 * given and rejected: "the working-tree diff contains only bookkeeping changes … it does not modify the
 * step-2 wizard". The council voted 5/5 to send it back, and 22 minutes and 148 calls ended with the run
 * announcing "Nothing was committed" over five commits that were sitting in the log.
 *
 * Two dots, not three: the question is what changed here since the task started, and the tree is part of it.
 */
export async function diffSince(
  cwd: string,
  sinceRef: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  const out = await git(["diff", sinceRef, "--", ".", ...excludeOwnState()], cwd);
  if (out.code !== 0) return "";
  const diff = out.stdout;
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n…diff truncated at ${MAX_DIFF_CHARS} characters — read the remaining files directly.`;
}
