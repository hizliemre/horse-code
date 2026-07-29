import type { Board } from "../board/board.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import { routeTask } from "./routing.js";
import { runImplementer } from "./implementer.js";
import { runCodeReview, type ReviewDeps } from "./review.js";
import { verifyAcceptance } from "./acceptance.js";
import type { Verdict, RunnableRole } from "./task-types.js";
import { telemetry } from "../obs/telemetry.js";
import { UNFIT_AFTER } from "./role-fitness.js";
import { worktreeState, hasWorkAgainst } from "./worktree-state.js";

/**
 * Fingerprint of a worktree's work: HEAD + dirty state. Per-write auto-commits mean finished work may already
 * be committed, so a plain `status --porcelain` is not enough — HEAD must be part of the signal. Returns
 * undefined when the path is not a usable git worktree (tests/stubs), which disables the guard.
 */

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
  board.setWorker(taskId, role, deps.roleRegistry.chainFor(role, rotation)[0] ?? "");
  const before = await worktreeState(git, cwd);
  await runImplementer(deps, role, board.get(taskId)!, cwd, rotation);
  const after = await worktreeState(git, cwd);

  // An implementer that produced NO change must never reach the review or the merge. With an empty worktree
  // the code review has nothing to reject, commitTask is a no-op and mergeTask reports "already up to date" —
  // so the task would be marked DONE having done nothing at all. Treat it as a failed attempt instead, which
  // sends it up the escalation ladder (senior-coder next) with an explicit instruction.
  /**
   * …unless the worktree ALREADY holds work relative to base.
   *
   * The question before a review is not "did this attempt add something" but "is there anything to judge".
   * A retried task carries its earlier work, so an implementer that looks, sees the job already done and
   * writes nothing is making a correct observation — not failing. Treating those as failures did real
   * damage: it recorded strikes against `cc/claude-opus-4-8` and benched it from `senior-coder` on 2 of 2,
   * for declining to rewrite code that was already there.
   */
  const idle = before !== undefined && after !== undefined && before === after
    && !(deps.baseRef && await hasWorkAgainst(git, cwd, deps.baseRef));
  if (idle) {
    const note = "The previous attempt produced NO file changes. You must actually write the code with write_file/edit_file — describing it is not enough.";
    /**
     * WHICH model wrote nothing, not just that something did.
     *
     * Caught live: two attempts ended in three seconds each — one model call, `finish_reason: stop`, no tool
     * calls at all. The model answered the implementer in prose and stopped. The ladder already rotates to
     * the role's next model, so the waste is bounded; what was missing was any way to see that one model
     * accounts for it. Named in the note and recorded as an event, so a pattern is visible rather than
     * inferred.
     */
    const servedBy = deps.roleRegistry.chainFor(role, rotation)[0] ?? "";
    telemetry().event("implementer.no_changes", {
      "hc.task.id": taskId, "hc.role": role, "hc.model": servedBy, "hc.attempt": board.get(taskId)!.attempts,
    });
    /**
     * The evidence goes on the record, not just in the log.
     *
     * A model that answers the implementer in prose has not had a bad call — it cannot do this role. Left
     * unrecorded, the automatic re-assignment hands it the same role again the next time anything is
     * benched, which is exactly how two models that never wrote a file ended up as `coder` and
     * `senior-coder` and stayed there through every manual correction.
     */
    if (servedBy) {
      const strikes = deps.fitness?.record(role, servedBy, "answered in prose instead of implementing") ?? 0;
      if (strikes === UNFIT_AFTER) {
        deps.note?.(`🚫 \`${servedBy}\` will no longer be assigned to \`${role}\` — ${strikes} attempts that wrote nothing. ` +
          `It stays available to every other role.`);
      }
    }
    board.appendStage(taskId, { role, action: "no-changes", note: servedBy ? `model: ${servedBy}` : undefined });
    board.clearReviewNotes(taskId);
    board.addReviewNote(taskId, note);
    board.move(taskId, "TODO", role);
    deps.note?.(`⚠️ **${board.get(taskId)!.title}** — \`${role}\`${servedBy ? ` on \`${servedBy}\`` : ""} wrote nothing; trying the next model.`);
    return { verdict: "fail", notes: [note], noProgress: true };
  }

  // The attempt produced changes, so this model CAN do this role. Recorded as the denominator the strikes
  // are judged against — without it, a model used a hundred times looks worse than one used twice.
  deps.fitness?.ok(role, deps.roleRegistry.chainFor(role, rotation)[0] ?? "");
  board.move(taskId, "REVIEW", role);

  // Code stage of the same team → council → judge review the docs get (single-shot; the escalation ladder retries).
  const card = board.get(taskId)!;
  // `attempts` drives the tiered bar: the first review of a task is the thorough pass, later attempts (the code
  // has already been revised for reviewer notes) are blocked only by CRITICAL findings.
  const review = () => runCodeReview(deps, cwd, card.title, undefined, (ev) => { if (ev.kind === "note") deps.note?.(ev.text); }, card.attempts);
  let v: Verdict;
  try {
    v = await telemetry().span("stage.code_review", { "hc.stage": "code review", "hc.task.id": taskId },
      () => (deps.timings ? deps.timings.time("code review", review) : review()));
  } catch (e) {
    if (!deps.signal.aborted) throw e;
    const note = "Review was cancelled. Add a human note before retrying this task.";
    board.clearReviewNotes(taskId);
    board.addReviewNote(taskId, note);
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:cancelled", note });
    return { verdict: "fail", notes: [note] };
  }
  if (deps.signal.aborted) {
    const note = "Review was cancelled. Add a human note before retrying this task.";
    board.clearReviewNotes(taskId);
    board.addReviewNote(taskId, note);
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:cancelled", note });
    return { verdict: "fail", notes: [note] };
  }
  // The review says the code is GOOD; the gate says the code does WHAT WAS ASKED. A task that quietly
  // implemented half the requirement passes review — only the criteria catch that.
  if (v.verdict === "pass") {
    const check = () => verifyAcceptance(deps, board.get(taskId)!, cwd, (ev) => { if (ev.kind === "note") deps.note?.(ev.text); });
    const gate = await telemetry().span("stage.acceptance_gate", { "hc.stage": "acceptance gate", "hc.task.id": taskId },
      () => (deps.timings ? deps.timings.time("acceptance gate", check) : check()));
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
