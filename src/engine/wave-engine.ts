import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { resolveMergeConflict } from "./conflict.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runTeamLead } from "./team-lead.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";

export interface WaveEngineDeps extends EscalationDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
}

export interface WaveOutcome {
  merged: string[];
  failed: string[];
  skipped: string[];
}

/** Promise-chain mutex: each call runs after the previous one; returns its result/error as-is. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Single wave: skip tasks with a blocked dependency; run the rest in parallel with a shared mutex +
 * resolveConflict (resolveMergeConflict inside the merge lock); classify the results.
 */
export async function runWave(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  taskIds: string[],
  blocked: Set<string>,
): Promise<WaveOutcome> {
  // A task already in DONE was implemented and merged by an earlier (interrupted) run — re-running it would
  // redo the whole implementation. Treat it as merged and move on.
  const alreadyDone = taskIds.filter((t) => board.get(t)!.column === "DONE");
  const rest = taskIds.filter((t) => !alreadyDone.includes(t));
  const skipped = rest.filter((t) => board.get(t)!.deps.some((d) => blocked.has(d)));
  const runnable = rest.filter((t) => !skipped.includes(t));
  for (const t of skipped) {
    board.appendStage(t, { role: "team-lead", action: "skipped", note: "dependency failed" });
  }

  const ser = createMutex();
  const results = await Promise.all(
    runnable.map(async (t) => {
      const resolveConflict = async (tw: TaskWorktree, files: string[]): Promise<MergeResult> => {
        try {
          const r = await resolveMergeConflict(deps, session, board, t, tw);
          return r.status === "resolved" ? { status: "merged" } : { status: "conflict", files };
        } catch (e) {
          // abort → rethrow (base may be left mid-merge; cleanup is left to session teardown — G/H).
          // If a queued sibling merge hits a dirty tree, git rejects it (won't return merged) → no false PR.
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
    merged: [...alreadyDone, ...results.filter((r) => r.status === "merged").map((r) => r.t)],
    failed: results.filter((r) => r.status !== "merged").map((r) => r.t),
    skipped,
  };
}

export type WaveEngineResult =
  | { status: "completed"; session: WorktreeSession; pr: { url: string }; waves: string[][] }
  | { status: "partial"; session: WorktreeSession; failed: string[]; skipped: string[]; waves: string[][] };

function teamLeadOpts(deps: WaveEngineDeps, session: WorktreeSession): RoleAgentOptions {
  const tl = deps.roleRegistry.resolve("team-lead");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  return {
    provider: deps.provider, ...tl,
    tools, messages: [], permission: deps.permission, approve: deps.approve,
    cwd: session.baseWorktree, signal: deps.signal,
  };
}

/** Runs waves within a session (NO openSession): team-lead → waves → push+openPR / {partial}. */
export async function runWaves(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  opts: { base: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const waves = await runTeamLead(teamLeadOpts(deps, session), board);

  const blocked = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wave of waves) {
    const o = await runWave(deps, session, board, wave, blocked);
    for (const t of o.failed) { blocked.add(t); failed.push(t); }
    for (const t of o.skipped) { blocked.add(t); skipped.push(t); }
    // successful merges were committed to base → the next wave derives from the updated base (D automatic)
  }

  if (failed.length === 0 && skipped.length === 0) {
    await deps.manager.push(session);
    const body = "Completed tasks:\n" + board.list().map((c) => `- ${c.title}`).join("\n");
    const pr = await deps.manager.openPR(session, deps.prAdapter, {
      base: opts.base,
      title: opts.prTitle ?? `hc: ${session.jobSlug}`,
      body,
    });
    return { status: "completed", session, pr, waves };
  }
  return { status: "partial", session, failed, skipped, waves };
}

/** Deterministic outer loop: openSession → runWaves (backward-compatible wrapper). */
export async function runWaveEngine(
  deps: WaveEngineDeps,
  board: Board,
  opts: { fromBranch: string; jobName: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  return runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
}
