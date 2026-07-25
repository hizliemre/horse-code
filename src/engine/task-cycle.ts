import type { Board } from "../board/board.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runCodeReview, type ReviewDeps } from "./review.js";
import type { Verdict, RunnableRole } from "./task-types.js";

/**
 * Fingerprint of a worktree's work: HEAD + dirty state. Per-write auto-commits mean finished work may already
 * be committed, so a plain `status --porcelain` is not enough — HEAD must be part of the signal. Returns
 * undefined when the path is not a usable git worktree (tests/stubs), which disables the guard.
 */
async function worktreeState(git: GitRunner, cwd: string): Promise<string | undefined> {
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const status = await git(["status", "--porcelain"], cwd);
  return `${head.stdout.trim()}|${status.stdout.trim()}`;
}

/** Single-round core with an explicit given role (NO routing): implement → review → Board transitions. */
export async function runCycleWithRole(
  deps: ReviewDeps,
  board: Board,
  taskId: string,
  cwd: string,
  role: RunnableRole,
  git: GitRunner = defaultGitRunner,
): Promise<Verdict> {
  board.move(taskId, "IN-PROGRESS", role);
  board.setModel(taskId, deps.roleRegistry.peekModel(role)); // surface the implementer model in the live-agents UI
  const before = await worktreeState(git, cwd);
  await runImplementer(deps, role, board.get(taskId)!, cwd);
  const after = await worktreeState(git, cwd);

  // An implementer that produced NO change must never reach the review or the merge. With an empty worktree
  // the code review has nothing to reject, commitTask is a no-op and mergeTask reports "already up to date" —
  // so the task would be marked DONE having done nothing at all. Treat it as a failed attempt instead, which
  // sends it up the escalation ladder (senior-coder next) with an explicit instruction.
  if (before !== undefined && after !== undefined && before === after) {
    const note = "The previous attempt produced NO file changes. You must actually write the code with write_file/edit_file — describing it is not enough.";
    board.appendStage(taskId, { role, action: "no-changes" });
    board.clearReviewNotes(taskId);
    board.addReviewNote(taskId, note);
    board.move(taskId, "TODO", role);
    deps.note?.(`⚠️ **${board.get(taskId)!.title}** — the implementer wrote nothing; retrying at the next tier.`);
    return { verdict: "fail", notes: [note] };
  }

  board.move(taskId, "REVIEW", role);

  // Code stage of the same team → council → judge review the docs get (single-shot; the escalation ladder retries).
  const card = board.get(taskId)!;
  // `attempts` drives the tiered bar: the first review of a task is the thorough pass, later attempts (the code
  // has already been revised for reviewer notes) are blocked only by CRITICAL findings.
  const v = await runCodeReview(deps, cwd, card.title, undefined, (ev) => { if (ev.kind === "note") deps.note?.(ev.text); }, card.attempts);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
    // Non-blocking findings ride the board to the end of the run, where the PR revision pass adjudicates them
    // in one go on the MERGED result — instead of forcing another full re-implementation of this task.
    for (const d of v.deferred ?? []) board.appendStage(taskId, { role: "code-reviewer", action: "deferred", note: d });
    board.clearReviewNotes(taskId);
    board.move(taskId, "DONE", "code-reviewer");
  } else {
    const notes = v.notes.length > 0 ? v.notes : ["review failed (no notes given)"];
    board.appendStage(taskId, {
      role: "code-reviewer",
      action: "reviewed:fail",
      note: notes.join("; "),
    });
    board.clearReviewNotes(taskId);
    for (const n of notes) board.addReviewNote(taskId, n);
    board.move(taskId, "TODO", "code-reviewer");
  }
  return v;
}

/** A task's single-round lifecycle: route → runCycleWithRole. */
export async function runTaskCycle(
  deps: ReviewDeps,
  board: Board,
  taskId: string,
  worktreePath: string,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskCycle: unknown task: ${taskId}`);

  const role = await routeTask(deps, task);
  board.setWorktree(taskId, worktreePath);
  return runCycleWithRole(deps, board, taskId, worktreePath, role);
}
