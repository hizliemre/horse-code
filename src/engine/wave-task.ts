import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult } from "../worktree/manager.js";
import { runTaskWithEscalation, type EscalationDeps } from "./escalation.js";
import { squashTask } from "./operational.js";
import { telemetry } from "../obs/telemetry.js";
import { changedByMerge, refreshTraces, describeRefresh } from "./trace-refresh.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";

/** E4a only uses these three methods (a narrow interface for stub/mock injection). */
export type WaveTaskManager = Pick<WorktreeManager, "deriveTask" | "commitTask" | "mergeTask">;

export interface WaveTaskDeps extends EscalationDeps {
  manager: WaveTaskManager;
  /** Injectable so tests drive the merge diff that decides which files get re-described. */
  git?: GitRunner;
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

  const git = deps.git ?? defaultGitRunner;
  const ser = deps.serialize ?? (<T>(f: () => Promise<T>) => f());
  const derive = () => ser(() => deps.manager.deriveTask(session, card.title));
  const tw = await (deps.timings ? deps.timings.time("git", derive) : derive());

  const rounds = Math.max(1, deps.rounds);
  // Isolate this task's failures: an implementer/reviewer that throws (e.g. hits its turn-count ceiling, or a
  // non-retryable model error) must fail ONLY this task, not reject the wave's Promise.all and crash the whole
  // job. A real cancel (aborted signal) still propagates. The job then ends "partial" with this task listed.
  let v;
  try {
    /**
     * One span around the WHOLE task, so everything under it is attributed to the task.
     *
     * The stage spans each carried the task id, but plenty of work happens between and around them — the
     * escalation council, the router, a retry's setup — and every tool call made there was recorded with no
     * task at all. Reading the log back, the busiest reads in a run all said "-": true, and useless for
     * answering "what did T049 actually do".
     */
    v = await telemetry().span("task", {
      "hc.task.id": taskId,
      "hc.task.title": card.title.slice(0, 120),
      "hc.slot": slot,
      "hc.attempt": card.attempts,
    }, () => runTaskWithEscalation({ ...deps, rounds }, board, taskId, tw.worktree, slot));
  } catch (e) {
    if (deps.signal.aborted) throw e; // genuine cancellation → propagate
    const msg = e instanceof Error ? e.message : String(e);
    board.appendStage(taskId, { role: "team-lead", action: "task-failed", note: msg });
    board.move(taskId, "ABANDONED", "team-lead"); // the ladder is spent — this is not waiting for a slot
    return { status: "task-failed", task: tw };
  }
  deps.signal.throwIfAborted(); // don't proceed to commit/merge if an abort came in during escalation

  if (v.verdict === "fail") {
    board.appendStage(taskId, { role: "team-lead", action: "task-failed" });
    board.move(taskId, "ABANDONED", "team-lead");
    return { status: "task-failed", task: tw };
  }

  // What the base looked like before this task landed, so the merge's own diff names the files to re-describe.
  const baseBefore = (await git(["rev-parse", "HEAD"], session.baseWorktree)).stdout.trim();

  // pass → commit the worktree changes to the task branch, then merge into base
  const land = async (): Promise<MergeResult> => {
    await deps.manager.commitTask(tw, `hc: ${card.title}`);
    // The per-file checkpoints did their job (a killed attempt kept its work); as history they say nothing.
    // One message, written from the whole diff, is what the base branch should carry.
    if (deps.baseRef) await squashTask(deps, tw.worktree, deps.baseRef, card.title);
    return ser(async () => {
      const r = await deps.manager.mergeTask(session, tw);
      if (r.status === "conflict" && deps.resolveConflict) return deps.resolveConflict(tw, r.files);
      return r;
    });
  };
  const mr = await (deps.timings ? deps.timings.time("git", land) : land());
  if (mr.status === "merged") {
    // Only git can say this. The review said the code was GOOD; this says it is in the base branch.
    board.move(taskId, "MERGED", "team-lead");
    board.appendStage(taskId, { role: "team-lead", action: "merged" });
    /**
     * The project's account of itself, brought level with the code that just landed.
     *
     * Here rather than at the end of the run: the next task in this wave reads `graph_trace` before touching
     * unfamiliar code, and what it must not read is the description of a file as it was before its
     * neighbour rewrote it. Merged work is the right trigger — reviewed, landed, and final.
     */
    await refreshAfterMerge(deps, session, git, baseBefore);
    return { status: "merged", task: tw };
  }
  board.appendStage(taskId, { role: "team-lead", action: "merge-conflict", note: mr.files.join(", ") });
  return { status: "conflict", files: mr.files, task: tw };
}


/**
 * Re-describes the files a merge brought in, in the worktree that owns the state.
 *
 * Best-effort by construction: the work is already merged, so nothing here may fail the task. A tracer that
 * is unavailable, rate-limited or simply absent from the registry leaves the traces as they were — stale,
 * and MARKED stale on read, which is the state the project was in before any of this existed.
 */
async function refreshAfterMerge(
  deps: WaveTaskDeps, session: WorktreeSession, git: GitRunner, baseBefore: string,
): Promise<void> {
  try {
    const files = await changedByMerge(git, session.baseWorktree, baseBefore);
    if (!files.length) return;
    const r = await refreshTraces({
      cwd: session.baseWorktree,
      files,
      provider: deps.provider,
      models: deps.roleRegistry.chainFor("tracer", 0),
      signal: deps.signal,
      note: (t) => deps.note?.(t),
    });
    const line = describeRefresh(r);
    if (line) deps.note?.(line);
  } catch { /* documentation must never be the reason a merged task is reported as failed */ }
}
