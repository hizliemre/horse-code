import type { Board } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runReviewer } from "./reviewer.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

/** Bir task'ın tek-tur yaşam döngüsü: route → implement → review → Board geçişleri. */
export async function runTaskCycle(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  worktreePath: string,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskCycle: bilinmeyen task: ${taskId}`);

  const role = await routeTask(deps, task);
  board.setWorktree(taskId, worktreePath);
  board.move(taskId, "IN-PROGRESS", role);

  await runImplementer(deps, role, board.get(taskId)!, worktreePath);
  board.move(taskId, "REVIEW", role);

  const v = await runReviewer(deps, board.get(taskId)!, worktreePath);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
    board.clearReviewNotes(taskId);
    board.move(taskId, "DONE", "code-reviewer");
  } else {
    const notes = v.notes.length > 0 ? v.notes : ["review başarısız (not verilmedi)"];
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
