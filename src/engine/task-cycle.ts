import type { Board } from "../board/board.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runCodeReview, type ReviewDeps } from "./review.js";
import { verifyAcceptance } from "./acceptance.js";
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
  /** Position among the parallel workers on this role → each leads with a different link of its chain. */
  slot = 0,
): Promise<Verdict> {
  board.move(taskId, "IN-PROGRESS", role);
  // Rotate by the attempt count too: the commonest reason an attempt produced nothing is that ITS MODEL
  // answered in prose instead of calling write_file, and re-running the identical model would reproduce
  // exactly that. Each retry therefore leads with the next link of the role's chain.
  const rotation = slot + board.get(taskId)!.attempts;
  // The UI must name the model this worker will ACTUALLY use, which is its rotated head, not the chain's.
  board.setModel(taskId, deps.roleRegistry.chainFor(role, rotation)[0] ?? "");
  const before = await worktreeState(git, cwd);
  await runImplementer(deps, role, board.get(taskId)!, cwd, rotation);
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
    deps.note?.(`⚠️ **${board.get(taskId)!.title}** — the implementer wrote nothing; escalating to a stronger role.`);
    return { verdict: "fail", notes: [note], noProgress: true };
  }

  board.move(taskId, "REVIEW", role);

  // Code stage of the same team → council → judge review the docs get (single-shot; the escalation ladder retries).
  const card = board.get(taskId)!;
  // `attempts` drives the tiered bar: the first review of a task is the thorough pass, later attempts (the code
  // has already been revised for reviewer notes) are blocked only by CRITICAL findings.
  const v = await runCodeReview(deps, cwd, card.title, undefined, (ev) => { if (ev.kind === "note") deps.note?.(ev.text); }, card.attempts);
  // The review says the code is GOOD; the gate says the code does WHAT WAS ASKED. A task that quietly
  // implemented half the requirement passes review — only the criteria catch that.
  if (v.verdict === "pass") {
    const gate = await verifyAcceptance(deps, board.get(taskId)!, cwd, (ev) => { if (ev.kind === "note") deps.note?.(ev.text); });
    if (!gate.passed) {
      board.appendStage(taskId, { role: "code-reviewer", action: "acceptance:failed", note: gate.unmet.join("; ") });
      board.clearReviewNotes(taskId);
      for (const n of gate.unmet) board.addReviewNote(taskId, `Acceptance criterion not met: ${n}`);
      board.move(taskId, "TODO", "code-reviewer");
      return { verdict: "fail", notes: gate.unmet };
    }
    board.appendStage(taskId, { role: "code-reviewer", action: "acceptance:passed" });
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
  /** Position among the parallel workers in this wave → spreads the role's chain across subscriptions. */
  slot = 0,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskCycle: unknown task: ${taskId}`);

  const role = await routeTask(deps, task);
  board.setWorktree(taskId, worktreePath);
  return runCycleWithRole(deps, board, taskId, worktreePath, role, defaultGitRunner, slot);
}
