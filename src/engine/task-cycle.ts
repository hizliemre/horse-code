import type { Board } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runReviewer } from "./reviewer.js";
import type { TaskCycleDeps, Verdict, RunnableRole } from "./task-types.js";

/** Single-round core with an explicit given role (NO routing): implement → review → Board transitions. */
export async function runCycleWithRole(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  cwd: string,
  role: RunnableRole,
): Promise<Verdict> {
  board.move(taskId, "IN-PROGRESS", role);
  await runImplementer(deps, role, board.get(taskId)!, cwd);
  board.move(taskId, "REVIEW", role);

  const v = await runReviewer(deps, board.get(taskId)!, cwd);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
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
  deps: TaskCycleDeps,
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
