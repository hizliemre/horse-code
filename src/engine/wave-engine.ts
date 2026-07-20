import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { runConflictCouncil } from "./conflict.js";

export interface WaveEngineDeps extends EscalationDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
}

export interface WaveOutcome {
  merged: string[];
  failed: string[];
  skipped: string[];
}

/** Söz-zinciri mutex: her çağrı öncekinin ardından koşar; sonucu/hatasını aynen döndürür. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Tek dalga: blocked bağımlılığa sahip task'ları atla; kalanları paylaşımlı mutex +
 * resolveConflict (merge kilidi içinde runConflictCouncil) ile paralel koş; sonuçları sınıfla.
 */
export async function runWave(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  taskIds: string[],
  blocked: Set<string>,
): Promise<WaveOutcome> {
  const skipped = taskIds.filter((t) => board.get(t)!.deps.some((d) => blocked.has(d)));
  const runnable = taskIds.filter((t) => !skipped.includes(t));
  for (const t of skipped) {
    board.appendStage(t, { role: "team-lead", action: "skipped", note: "bağımlılık başarısız" });
  }

  const ser = createMutex();
  const results = await Promise.all(
    runnable.map(async (t) => {
      const resolveConflict = async (tw: TaskWorktree, files: string[]): Promise<MergeResult> => {
        try {
          const r = await runConflictCouncil(deps, session, board, t, tw);
          return r.status === "resolved" ? { status: "merged" } : { status: "conflict", files };
        } catch (e) {
          if (deps.signal.aborted) throw e;
          try { await deps.manager.abortMerge(session); } catch { /* zaten temiz olabilir */ }
          return { status: "conflict", files };
        }
      };
      const res = await runWaveTask({ ...deps, serialize: ser, resolveConflict }, session, board, t);
      return { t, status: res.status };
    }),
  );

  return {
    merged: results.filter((r) => r.status === "merged").map((r) => r.t),
    failed: results.filter((r) => r.status !== "merged").map((r) => r.t),
    skipped,
  };
}
