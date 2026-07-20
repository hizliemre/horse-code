import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import { runTaskWithEscalation, type EscalationDeps } from "./escalation.js";

/** E4a yalnızca bu üç metodu kullanır (stub/mock enjeksiyonu için dar arayüz). */
export type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">;

export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  /** Git-mutating adımları (derive, merge) serileştiren mutex; paralel dalgada E4c sağlar.
   *  Varsayılan: kimlik. */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type TaskResult =
  | { status: "merged"; task: TaskWorktree }
  | { status: "conflict"; files: string[]; task: TaskWorktree }
  | { status: "task-failed"; task: TaskWorktree };

/**
 * Bir task'ın dalga içi yaşam döngüsü: base'den worktree türet → escalation ile koş →
 * geçerse worktree'yi commit'le + base'e merge. Conflict yalnızca relay edilir (çözüm E4b).
 */
export async function runWaveTask(
  deps: WaveTaskDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
): Promise<TaskResult> {
  const card = board.get(taskId);
  if (!card) throw new Error(`runWaveTask: bilinmeyen task: ${taskId}`);

  const ser = deps.serialize ?? (<T>(f: () => Promise<T>) => f());
  const tw = await ser(() => deps.manager.deriveTask(session, card.title));

  const rounds = Math.max(1, deps.rounds);
  const v = await runTaskWithEscalation({ ...deps, rounds }, board, taskId, tw.worktree);

  if (v.verdict === "fail") {
    board.appendStage(taskId, { role: "team-lead", action: "task-failed" });
    return { status: "task-failed", task: tw };
  }

  // pass → worktree değişikliklerini task branch'ine commit'le, sonra base'e merge et
  await deps.manager.commitTask(tw, `hc: ${card.title}`);
  const mr = await ser(() => deps.manager.mergeTask(session, tw));
  if (mr.status === "merged") {
    board.appendStage(taskId, { role: "team-lead", action: "merged" });
    return { status: "merged", task: tw };
  }
  board.appendStage(taskId, { role: "team-lead", action: "merge-conflict", note: mr.files.join(", ") });
  return { status: "conflict", files: mr.files, task: tw };
}
