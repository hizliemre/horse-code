import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult } from "../worktree/manager.js";
import { runTaskWithEscalation, type EscalationDeps } from "./escalation.js";

/** E4a only uses these three methods (a narrow interface for stub/mock injection). */
export type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">;

export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  /** Mutex serializing the git-mutating steps (derive, merge); provides E4c in a parallel wave.
   *  Default: identity. */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Resolves a conflict inside the serialized merge block (E4c wiring: runConflictCouncil). */
  resolveConflict?: (task: TaskWorktree, files: string[]) => Promise<MergeResult>;
}

/**
 * runWaveTask result. Contract notes for the caller (E4b/E4c):
 * - `conflict`: the base worktree is left mid-merge (`MERGE_HEAD` exists) — BEFORE the next
 *   `mergeTask`, E4b must resolve + `commitMerge` or `abortMerge`.
 * - No branch cleans up the task worktree/branch (`removeTask`/`closeSession` → E4c).
 */
export type TaskResult =
  | { status: "merged"; task: TaskWorktree }
  | { status: "conflict"; files: string[]; task: TaskWorktree }
  | { status: "task-failed"; task: TaskWorktree };

/**
 * A task's in-wave lifecycle: derive a worktree from base → run it through escalation →
 * on success, commit the worktree + merge into base. Conflicts are only relayed (resolution is E4b).
 */
export async function runWaveTask(
  deps: WaveTaskDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
  /** This task's index within its wave → its implementer leads with a different link of the role's chain. */
  slot = 0,
): Promise<TaskResult> {
  const card = board.get(taskId);
  if (!card) throw new Error(`runWaveTask: unknown task: ${taskId}`);

  const ser = deps.serialize ?? (<T>(f: () => Promise<T>) => f());
  const tw = await ser(() => deps.manager.deriveTask(session, card.title));

  const rounds = Math.max(1, deps.rounds);
  // Isolate this task's failures: an implementer/reviewer that throws (e.g. hits its turn-count ceiling, or a
  // non-retryable model error) must fail ONLY this task, not reject the wave's Promise.all and crash the whole
  // job. A real cancel (aborted signal) still propagates. The job then ends "partial" with this task listed.
  let v;
  try {
    v = await runTaskWithEscalation({ ...deps, rounds }, board, taskId, tw.worktree, slot);
  } catch (e) {
    if (deps.signal.aborted) throw e; // genuine cancellation → propagate
    const msg = e instanceof Error ? e.message : String(e);
    board.appendStage(taskId, { role: "team-lead", action: "task-failed", note: msg });
    return { status: "task-failed", task: tw };
  }
  deps.signal.throwIfAborted(); // don't proceed to commit/merge if an abort came in during escalation

  if (v.verdict === "fail") {
    board.appendStage(taskId, { role: "team-lead", action: "task-failed" });
    return { status: "task-failed", task: tw };
  }

  // pass → commit the worktree changes to the task branch, then merge into base
  await deps.manager.commitTask(tw, `hc: ${card.title}`);
  const mr = await ser(async () => {
    const r = await deps.manager.mergeTask(session, tw);
    if (r.status === "conflict" && deps.resolveConflict) return deps.resolveConflict(tw, r.files);
    return r;
  });
  if (mr.status === "merged") {
    board.appendStage(taskId, { role: "team-lead", action: "merged" });
    return { status: "merged", task: tw };
  }
  board.appendStage(taskId, { role: "team-lead", action: "merge-conflict", note: mr.files.join(", ") });
  return { status: "conflict", files: mr.files, task: tw };
}
