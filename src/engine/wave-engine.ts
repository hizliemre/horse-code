import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { resolveMergeConflict } from "./conflict.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runTeamLead } from "./team-lead.js";
import { splitFileConflicts, waveStats, describeWaves, normalizePath, type FileClash } from "./waves.js";
import { describeTimings } from "./timings.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import { telemetry } from "../obs/telemetry.js";

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

/** Enough to fetch one skill and answer. The audit has nothing to explore — everything it needs is given. */
export const TEAM_LEAD_MAX_TURNS = 3;

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
/**
 * How many times one task may be woken in a single run.
 *
 * Not a verdict on the task — a bound on spend. Waking requires that something ELSE merged, so the supply of
 * wakes is already limited by real progress; this only stops one pathological task from consuming a run in
 * which everything else keeps landing.
 */
export const MAX_WAKES = 3;

/**
 * How many failed conflict resolutions before the task is REWRITTEN instead of merged again.
 *
 * A merge conflict is normally a sign that the base moved, and retrying after another merge is the right
 * answer. Past a few failures it stops being that and becomes a sign that the branch's ROOT is too old for
 * the conflict to be resolvable at all: measured on a real board, two tasks passed review five times between
 * them and never landed, because their branches were rooted 49 and 68 commits back and the resolver ran out
 * of turns on a seven-file drift every single time. Merging harder cannot fix a distance problem.
 */
export const RESTART_AFTER_CONFLICTS = 3;

/**
 * …and how many rewrites one task may have. A rewrite is expensive — it discards work that passed review —
 * so a task that cannot land even from today's base must stop and say so rather than loop.
 */
export const MAX_RESTARTS = 2;

export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Runs every task the moment its dependencies are merged — not when its "wave" comes round.
 *
 * The engine used to run strict layers: every task of wave N had to finish before ANY task of wave N+1
 * could start. Measured on a real 94-task board that is 17 layers, and the board sat with 63 tasks in TODO
 * and ONE agent running, because that agent was the last unfinished task of layer 5 and the seventeen tasks
 * of layer 6 were not allowed to begin. A layer is an artefact of how the schedule was computed; the only
 * thing that actually constrains a task is what it depends on.
 *
 * Three rules, all of them local:
 * - a task starts when every dependency it declares has MERGED;
 * - at most `maxParallel` run at once, each holding a slot so the model rotation still spreads;
 * - a task does not start while a RUNNING task writes a file it writes — the same protection the layer
 *   split gave, applied against what is genuinely in flight rather than against a layer.
 *
 * A failed task blocks everything downstream of it, transitively; those are reported as skipped, exactly as
 * the layered engine did.
 */
export async function runReady(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
): Promise<WaveOutcome> {
  const ser = createMutex();
  const cards = board.list();
  // A task already in DONE was implemented and merged by an earlier (interrupted) run — re-running it would
  // redo the whole implementation.
  /**
   * Only MERGED means delivered.
   *
   * This used to accept DONE, which a card reaches when its review passes — before the merge is even
   * attempted. A conflict then left the card reading DONE with its code in a task branch nobody would look
   * at again, and the next resume skipped it as finished. Measured on a real board: 70 DONE, 7 of them never
   * merged, and one merge commit in five and a half hours.
   */
  const done = new Set(cards.filter((c) => c.column === "MERGED").map((c) => c.id));
  const merged = [...done];
  const failed: string[] = [];
  const skipped: string[] = [];
  /**
   * Why each task cannot go on RIGHT NOW — and therefore what would let it.
   *
   * A task used to be abandoned the moment its ladder ran out, as if that were a verdict. Measured over one
   * day on one board: THIRTY tasks were abandoned at some point and TWENTY-NINE later passed review,
   * unchanged, simply because something tried them again. A decision that is wrong twenty-nine times out of
   * thirty is not a decision — it is a pause with the wrong name.
   *
   * So the reason is recorded, and the reason is what wakes it:
   *   waiting   — a dependency has not merged. Wakes when THAT task merges; never runs before then.
   *   exhausted — it ran and used up its ladder. Wakes when anything merges: the base has moved and the
   *               ground its last review stood on is gone.
   *   conflict  — its review passed but the merge clashed. Same waking rule, and the strongest case for it:
   *               the conflict IS the base having moved.
   */
  type ParkReason = "waiting" | "exhausted" | "conflict";
  interface Parked { reason: ParkReason; on?: string; mergedAt: number; wakes: number }
  const parked = new Map<string, Parked>();
  /** Tasks whose merge has failed often enough to be rewritten, with the worktree to retire. */
  const restartOn = new Map<string, TaskWorktree>();
  /** Failed resolutions since this task was last rewritten — a rewrite starts the count over. */
  const conflictRuns = (cardId: string): number => {
    const h = board.get(cardId)?.stageHistory ?? [];
    const since = h.map((e) => e.action).lastIndexOf("restarted");
    return h.slice(since + 1).filter((e) => e.action === "conflict:resolve-failed").length;
  };
  const restartsSoFar = (cardId: string): number =>
    (board.get(cardId)?.stageHistory ?? []).filter((e) => e.action === "restarted").length;
  const pending = new Set(cards.filter((c) => !done.has(c.id)).map((c) => c.id));
  /**
   * A NEW run gives every unfinished task a fresh ladder.
   *
   * `attempts` drives the tier — implementer, then senior, then council — and it was persisted, so a task
   * that had failed a lot came back BORN EXHAUSTED. Measured on a real board: four tasks at 12, 16, 18 and 21
   * attempts, every one of them starting at the council tier, which is the most expensive path and the one
   * that had already failed them repeatedly. They never got another cheap, direct attempt, however much the
   * machinery around them had been fixed in the meantime.
   *
   * The evidence that this was wrong is that a human kept correcting it: this board was reset by hand five
   * times in one day, and every time the point was to let the fixed pipeline try again from the bottom.
   *
   * The history is NOT lost — `stageHistory` keeps every attempt, and the streak gate reads it. Only the
   * tier counter starts over, and only for work that has not been delivered.
   */
  for (const id of pending) {
    const c = board.get(id);
    if (!c || c.attempts === 0) continue;
    board.resetAttempts(id);
  }
  const busy = new Set<string>();                     // files held by a task that is running right now
  const running = new Map<number, Promise<number>>(); // slot → its task, resolving to the slot it frees
  /**
   * Slot numbers spread each role's model chain across its parallel workers, so they are recycled rather
   * than counted: a freed slot is handed to the next task, and a new one is minted only when the ceiling
   * rises. Read on every pass, so raising the ceiling mid-run takes effect at the next completion instead
   * of at the next job.
   */
  const free: number[] = [];
  let minted = 0;
  const ceiling = (): number => Math.max(1, deps.maxParallel ?? MAX_PARALLEL_TASKS);
  const depsOf = (id: string): string[] => board.get(id)?.deps ?? [];
  const filesOf = (id: string): string[] => (board.get(id)?.files ?? []).map(normalizePath).filter(Boolean);

  /**
   * Parks a task with the reason that will later wake it. Its ladder starts over when it wakes, so a task
   * that comes back gets the cheap, direct tier again rather than resuming at the council.
   */
  const park = (id: string, reason: ParkReason, on?: string, startedAt?: number): void => {
    /**
     * The baseline is when the ATTEMPT began, not when it ended.
     *
     * A task runs for minutes; other tasks merge while it does. Anchoring to the moment of parking meant a
     * merge that landed DURING the attempt did not count as new information, and the task slept through the
     * very change that would have let it pass.
     */
    parked.set(id, { reason, on, mergedAt: startedAt ?? merged.length, wakes: wakeCount.get(id) ?? 0 });
    pending.delete(id);
    board.appendStage(id, {
      role: "team-lead", action: "parked",
      note: reason === "waiting" ? `waiting for ${on}` : reason === "conflict" ? "merge conflicted" : "ladder exhausted",
    });
    board.move(id, "PARKED", "team-lead");
  };

  /**
   * Wakes whatever the world has just made runnable again.
   *
   * Each reason asks its own question, which is the point: a task waiting on T060 has no business waking
   * because T044 merged, and a task whose merge conflicted has every business waking because ANY merge moves
   * the base it conflicted with.
   */
  const wake = (): number => {
    let woken = 0;
    for (const [id, p] of [...parked]) {
      if (p.wakes >= MAX_WAKES) continue;
      const ready = p.reason === "waiting"
        ? p.on !== undefined && done.has(p.on)
        : merged.length > p.mergedAt;   // something landed since it was parked
      if (!ready) continue;
      parked.delete(id);
      pending.add(id);
      board.resetAttempts(id);
      board.appendStage(id, { role: "team-lead", action: "woken", note: `${p.reason} → retrying (wake ${p.wakes + 1})` });
      board.move(id, "TODO", "team-lead");
      wakeCount.set(id, p.wakes + 1);
      woken += 1;
    }
    return woken;
  };
  /** How many times each task has been woken, so a re-park remembers and the cap can bite. */
  const wakeCount = new Map<string, number>();

  /** A dependency that is parked is not a dead end — the dependent waits for it BY NAME. */
  const parkUnreachable = (): void => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...pending]) {
        const blocker = depsOf(id).find((d) => parked.has(d));
        if (blocker === undefined) continue;
        park(id, "waiting", blocker);
        changed = true;
      }
    }
  };

  while (pending.size > 0 || running.size > 0 || parked.size > 0) {
    parkUnreachable();
    const limit = ceiling();
    for (const id of [...pending]) {
      if (running.size >= limit) break;
      if (!depsOf(id).every((d) => done.has(d))) continue;
      const files = filesOf(id);
      if (files.some((f) => busy.has(f))) continue; // a running task owns that file → take it on the next pass
      pending.delete(id);
      telemetry().event("decision.schedule", {
        "hc.decision": "schedule",
        "hc.task.id": id,
        "hc.slot": free[free.length - 1] ?? minted,
        "hc.running": running.size + 1,
        "hc.limit": limit,
        "hc.pending": pending.size,
      });
      for (const f of files) busy.add(f);
      const mergedAtStart = merged.length; // the world as this attempt found it — see park()
      const slot = free.pop() ?? minted++;
      running.set(slot, (async () => {
        try {
          const resolveConflict = async (tw: TaskWorktree, conflicted: string[]): Promise<MergeResult> => {
            try {
              const r = await resolveMergeConflict(deps, session, board, id, tw);
              return r.status === "resolved" ? { status: "merged" } : { status: "conflict", files: conflicted };
            } catch (e) {
              // abort → rethrow (base may be left mid-merge; cleanup is left to session teardown).
              // If a queued sibling merge hits a dirty tree, git rejects it (won't return merged) → no false PR.
              if (deps.signal.aborted) throw e;
              /**
               * WHY the resolution failed, on the card.
               *
               * `conflict:resolve-attempt` is only written once the resolver has finished, so a resolution
               * that THREW left no trace at all: a real board showed T060 passing its review, hitting a
               * merge conflict, and stopping — with nothing to say whether the resolver had run, failed, or
               * never started. Three tasks waited behind that silence.
               */
              board.appendStage(id, {
                role: "operational", action: "conflict:resolve-failed",
                note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
              });
              if (conflictRuns(id) >= RESTART_AFTER_CONFLICTS && restartsSoFar(id) < MAX_RESTARTS) {
                restartOn.set(id, tw); // the merge is not the problem any more — see RESTART_AFTER_CONFLICTS
              }
              try { await deps.manager.abortMerge(session); } catch { /* zaten temiz olabilir */ }
              return { status: "conflict", files: conflicted };
            }
          };
          const res = await runWaveTask({ ...deps, serialize: ser, resolveConflict, baseRef: session.baseBranch }, session, board, id, slot);
          if (res.status === "merged") { merged.push(id); done.add(id); }
          else if (res.status === "conflict" && restartOn.has(id)) {
            /**
             * Rewrite rather than park.
             *
             * Parking here would wait for another merge to move the base — but the base moving is exactly
             * what put this branch out of reach, and waiting has already been tried. Retiring the worktree
             * sends the task back through the pipeline from TODAY's base, where the same work merges cleanly.
             */
            const tw = restartOn.get(id)!;
            restartOn.delete(id);
            try {
              const retired = await deps.manager.restartTask(session, tw);
              board.appendStage(id, {
                role: "team-lead", action: "restarted",
                note: `merge unresolvable after ${RESTART_AFTER_CONFLICTS} attempts — rewriting from the ` +
                  `current base (the reviewed work is kept on ${retired})`,
              });
              board.resetAttempts(id);
              board.move(id, "TODO", "team-lead");
              pending.add(id);
            } catch (e) {
              // Retiring failed (a locked worktree, a branch name in use). Parking still beats losing the card.
              board.appendStage(id, {
                role: "team-lead", action: "restart-failed",
                note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
              });
              park(id, "conflict", undefined, mergedAtStart);
            }
          }
          else park(id, res.status === "conflict" ? "conflict" : "exhausted", undefined, mergedAtStart);
        } finally {
          for (const f of files) busy.delete(f);
          free.push(slot);
        }
        return slot;
      })());
    }
    if (running.size === 0) {
      /**
       * Nothing running, nothing startable. Before giving up, ask whether the world has changed since each
       * parked task last tried — that is the only thing that could make a retry mean anything.
       */
      if (wake() > 0) continue;
      /**
       * Nothing can wake: every parked task is either waiting on something that will never merge, or has
       * already been tried since the last merge, or is out of wakes. THIS is the verdict `abandoned` was
       * always claiming to be, and now it is earned rather than assumed.
       */
      for (const [id, p] of parked) {
        (p.reason === "waiting" ? skipped : failed).push(id);
        board.appendStage(id, {
          role: "team-lead", action: "abandoned",
          note: p.wakes >= MAX_WAKES ? `out of wakes after ${p.wakes}` : `${p.reason}: nothing left that could change it`,
        });
        board.move(id, "ABANDONED", "team-lead");
      }
      for (const id of pending) {
        skipped.push(id);
        board.appendStage(id, { role: "team-lead", action: "abandoned", note: "its dependencies never completed" });
        board.move(id, "ABANDONED", "team-lead");
      }
      parked.clear();
      pending.clear();
      break;
    }
    running.delete(await Promise.race(running.values()));
    wake(); // a merge just landed: whatever it unblocks goes back in the queue now, not at the end
  }

  return { merged, failed, skipped };
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
    /**
     * The question is answerable from the prompt alone — the tasks, their files and their criteria are all
     * in it. Left at the default fifty turns per attempt, a model that would not call `submit` walked its
     * whole fallback chain instead: seventy-three calls and 1.5M tokens re-sending the same task list, four
     * and a half minutes before a single agent started, and nothing on screen to say so.
     */
    maxTurns: TEAM_LEAD_MAX_TURNS,
  };
}

/** Runs waves within a session (NO openSession): team-lead → waves → push+openPR / {partial}. */
export async function runWaves(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  opts: { base: string; prTitle?: string },
): Promise<WaveEngineResult> {
  /**
   * Said before it happens, not after.
   *
   * The first thing a wave run does is read the whole plan and ask whether the dependencies are right. That
   * is one call over a hundred task cards, and while it runs there is no agent and no tool line — a resumed
   * job sat at "Coding… 0 calls" for a minute with nothing on screen to say anything was happening.
   */
  const todo = board.list().filter((c) => c.column !== "MERGED").length;
  deps.note?.(`🧭 Planning the run — ${todo} task(s) left, up to ${deps.maxParallel ?? MAX_PARALLEL_TASKS} at a time. ` +
    `Checking their dependencies before scheduling.`);
  const plan = await runTeamLead(teamLeadOpts(deps, session), board);
  if (plan.skipped) deps.note?.(`🧭 Dependency check skipped — ${plan.skipped}. Scheduling from the plan as written.`);
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
      `🔀 ${clashes.length} task pair(s) write the same file — they will not run at the same time: ` +
      `${clashes.slice(0, 3).map((c: FileClash) => `${c.a}/${c.b} (${c.files[0]})`).join(", ")}` +
      `${clashes.length > 3 ? ", …" : ""}`);
  }

  const outcome = await runReady(deps, session, board);
  const failed = outcome.failed;
  const skipped = outcome.skipped;

  const delivery: Delivery = { branch: session.baseBranch, worktree: session.baseWorktree };
  // Whether the breakdown was any good is not visible from "completed": twenty tasks in twenty waves and
  // twenty tasks in three cost the same on paper and wildly different in wall-clock. Report the numbers.
  deps.note?.(`📊 ${describeWaves(waveStats(board, waves, clashes))}`);
  // Where the time went, not just what happened: the two answer different questions and only one of them
  // says what to fix.
  if (deps.timings && !deps.timings.empty) deps.note?.(describeTimings(deps.timings));
  const shape = waveStats(board, waves, clashes);
  telemetry().event("run.summary", {
    "hc.tasks": shape.tasks, "hc.layers": shape.waves, "hc.widest": shape.widest,
    "hc.clashes": shape.clashes, "hc.conflicts": shape.conflicts,
    "hc.failed": shape.failed, "hc.skipped": shape.skipped, "hc.attempts": shape.attempts,
  });

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
