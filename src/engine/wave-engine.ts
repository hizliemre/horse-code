import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { resolveMergeConflict } from "./conflict.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runTeamLead } from "./team-lead.js";
import { splitFileConflicts, waveStats, describeWaves, type FileClash } from "./waves.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";

export interface WaveEngineDeps extends EscalationDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
  /** How many tasks of one wave may be in flight at once. Defaults to MAX_PARALLEL_TASKS. */
  maxParallel?: number;
}

/**
 * A wave used to start EVERY runnable task at once, with no ceiling — a twenty-task wave meant twenty agents,
 * each with its own worktree, its own history and its own stream.
 *
 * Nothing about the board bounds that number; it is whatever the breakdown happened to produce. Two heap
 * exhaustions and the provider's rate limits were both reached this way, and a wave that dies halfway leaves
 * more skipped tasks than a narrower one that finishes. The cap costs wall-clock only when a wave is wider
 * than it, and only for the tasks past the ceiling.
 */
export const MAX_PARALLEL_TASKS = 4;

/** Runs `fn` over every item, at most `limit` at a time, and returns the results in the ORIGINAL order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
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
  const limit = deps.maxParallel ?? MAX_PARALLEL_TASKS;
  if (runnable.length > limit) {
    deps.note?.(`⏳ ${runnable.length} task(s) in this wave — running ${limit} at a time.`);
  }
  const results = await mapWithLimit(
    runnable, limit,
    async (t, slot) => {
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
      const res = await runWaveTask({ ...deps, serialize: ser, resolveConflict }, session, board, t, slot);
      return { t, status: res.status };
    },
  );

  return {
    merged: [...alreadyDone, ...results.filter((r) => r.status === "merged").map((r) => r.t)],
    failed: results.filter((r) => r.status !== "merged").map((r) => r.t),
    skipped,
  };
}

/**
 * How the finished work reached the user.
 *
 * Carried on every outcome, including a partial one. A run that produced twenty-one working tasks and told
 * the user only "partial" left the work on a branch nobody knew existed — the code was fine, the delivery
 * was missing, and from the outside those are indistinguishable from a failure.
 */
export interface Delivery {
  /** The branch every completed task was merged into. Always present: it is where the work IS. */
  branch: string;
  /** The worktree it was built in, still on disk. */
  worktree: string;
  /** Set when the work was merged into the branch the job started from. */
  mergedInto?: string;
  /** Why it was not merged, when it was not — so the report can say what to do instead. */
  notMerged?: string;
}

export type WaveEngineResult =
  | { status: "completed"; session: WorktreeSession; pr?: { url: string }; delivery: Delivery; waves: string[][] }
  | { status: "partial"; session: WorktreeSession; pr?: undefined; failed: string[]; skipped: string[]; delivery: Delivery; waves: string[][] };

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
  const plan = await runTeamLead(teamLeadOpts(deps, session), board);
  if (plan.added.length) {
    deps.note?.(
      `🔗 ${plan.added.length} dependency the breakdown did not state — ${plan.added
        .map((f) => `${f.task} needs ${f.needs}`).join(", ")}. Those tasks no longer run together.`);
  }
  if (plan.suspected.length) {
    deps.note?.(
      `💤 ${plan.suspected.length} dependency looks unnecessary and is holding work back: ${plan.suspected
        .map((f) => `${f.task}→${f.needs}`).join(", ")}. Left in place.`);
  }
  /**
   * The last word on what may run together, and it is not the plan's.
   *
   * `deps` is an account nothing verifies; a dependency it omits shows up as two agents editing one file in
   * separate worktrees and a merge conflict hours later. Applied AFTER the team-lead so it holds whichever
   * waves were chosen — the file lists are evidence, and no confirmation step may override them.
   */
  const { waves, clashes } = splitFileConflicts(plan.waves, board);
  if (clashes.length) {
    deps.note?.(
      `🔀 ${clashes.length} task pair(s) would have written the same file in one wave — separated so they run in ` +
      `sequence: ${clashes.slice(0, 3).map((c: FileClash) => `${c.a}/${c.b} (${c.files[0]})`).join(", ")}` +
      `${clashes.length > 3 ? ", …" : ""}`);
  }

  const blocked = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wave of waves) {
    const o = await runWave(deps, session, board, wave, blocked);
    for (const t of o.failed) { blocked.add(t); failed.push(t); }
    for (const t of o.skipped) { blocked.add(t); skipped.push(t); }
    // successful merges were committed to base → the next wave derives from the updated base (D automatic)
  }

  const delivery: Delivery = { branch: session.baseBranch, worktree: session.baseWorktree };
  // Whether the breakdown was any good is not visible from "completed": twenty tasks in twenty waves and
  // twenty tasks in three cost the same on paper and wildly different in wall-clock. Report the numbers.
  deps.note?.(`📊 ${describeWaves(waveStats(board, waves, clashes))}`);

  /**
   * Only the PULL REQUEST is opened here. The merge is not.
   *
   * The review that runs after this stage commits to the same base branch, so merging now would deliver a
   * snapshot taken before the review's own fixes — the user's branch would be missing exactly the commits
   * the review was run to produce. Delivery therefore happens at the end of the job, after the review.
   */
  if (failed.length === 0 && skipped.length === 0) {
    await deps.manager.push(session);
    // A pull request is delivery when there is a remote to open it against; when there is not, the merge is.
    if (await deps.manager.hasRemote(session)) {
      const body = "Completed tasks:\n" + board.list().map((c) => `- ${c.title}`).join("\n");
      const pr = await deps.manager.openPR(session, deps.prAdapter, {
        base: opts.base,
        title: opts.prTitle ?? `hc: ${session.jobSlug}`,
        body,
      });
      return { status: "completed", session, pr, delivery, waves };
    }
    return { status: "completed", session, delivery, waves };
  }
  return { status: "partial", session, failed, skipped, delivery, waves };
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
