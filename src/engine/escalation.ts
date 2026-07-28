import type { Board, Card } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runCycleWithRole } from "./task-cycle.js";
import { runEscalationCouncil } from "./council.js";
import type { Verdict, RunnableRole } from "./task-types.js";
import type { ReviewDeps } from "./review.js";
import { telemetry } from "../obs/telemetry.js";

export type HumanDecision =
  | { action: "accept" }
  | { action: "retry"; notes: string[] }
  | { action: "abandon" };

export type AskHuman = (ctx: { card: Card; verdict: Verdict }) => Promise<HumanDecision>;

/**
 * Autonomous "human" seam: for an unattended run there is nobody to prompt, so a task that exhausts the
 * escalation ladder is auto-retried up to `maxRetries` times (feeding the council's own notes back in), then
 * abandoned. This keeps a long run moving on its own instead of blocking on an interactive prompt per failure.
 */
export function autonomousAskHuman(maxRetries = 2): AskHuman {
  const retries = new Map<string, number>();
  return async ({ card, verdict }) => {
    const n = retries.get(card.id) ?? 0;
    if (n >= maxRetries) return { action: "abandon" };
    retries.set(card.id, n + 1);
    const notes = verdict.notes.length > 0 ? verdict.notes : ["Address the review feedback and complete the task."];
    return { action: "retry", notes };
  };
}

export interface EscalationDeps extends ReviewDeps {
  rounds: number; // turns per tier (config escalation.rounds; default 3)
  askHuman: AskHuman;
}

/** Derives the tier from attempts + turns-per-tier: 0 implementer, 1 senior, 2 council. */
export function tierOf(attempts: number, rounds: number): 0 | 1 | 2 {
  return attempts < rounds ? 0 : attempts < 2 * rounds ? 1 : 2;
}

/**
 * Records a thrown attempt (turn-count ceiling, non-retryable model error) as a failed verdict WITHOUT killing
 * the task, and feeds the error back as a review note so the next tier has context. The card is returned to
 * TODO (the throw may have left it mid-run in IN-PROGRESS/REVIEW). Returns a fail verdict for the caller.
 */
function attemptError(board: Board, taskId: string, role: string, e: unknown): Verdict {
  const msg = e instanceof Error ? e.message : String(e);
  board.appendStage(taskId, { role, action: "attempt-error", note: msg });
  board.addReviewNote(taskId, `The previous attempt did not finish (${msg}). Complete the task within the turn budget.`);
  board.move(taskId, "TODO", role);
  return { verdict: "fail", notes: [msg] };
}

/**
 * Task-level escalation ladder: route→family, tier(attempts/N) escalates the role
 * (implementer → senior → council). If the council can't resolve it either, the askHuman seam kicks in (accept/retry/abandon).
 */
export async function runTaskWithEscalation(
  deps: EscalationDeps,
  board: Board,
  taskId: string,
  cwd: string,
  /** Position among the parallel workers in this wave → spreads the role's chain across subscriptions. */
  slot = 0,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskWithEscalation: unknown task: ${taskId}`);

  const family = await routeTask(deps, task); // once: coder | designer
  board.setWorktree(taskId, cwd);

  for (;;) {
    const attempts = board.get(taskId)!.attempts;
    const tier = tierOf(attempts, deps.rounds);
    telemetry().event("decision.tier", {
      "hc.decision": "tier", "hc.task.id": taskId, "hc.tier": tier, "hc.attempt": attempts, "hc.family": family,
    });

    if (tier < 2) {
      const role: RunnableRole =
        tier === 0 ? family : family === "designer" ? "senior-designer" : "senior-coder";
      let v: Verdict;
      try {
        v = await runCycleWithRole(deps, board, taskId, cwd, role, undefined, slot);
      } catch (e) {
        if (deps.signal.aborted) throw e; // genuine cancellation → propagate
        // The attempt THREW (e.g. hit its turn-count ceiling, or a non-retryable model error). Treat it as a
        // failed attempt and ESCALATE to the next tier — do NOT kill the task. A senior/council pass may still
        // rescue it, which is what "run it autonomously" needs.
        v = attemptError(board, taskId, role, e);
      }
      if (v.verdict === "pass") return v; // runCycleWithRole moved it to DONE
      if (v.noProgress) {
        /**
         * Nothing was written at all — but a same-tier retry is NOT a repeat.
         *
         * `runCycleWithRole` leads with `slot + attempts` of the role's chain, so the next attempt is a
         * DIFFERENT model given the same instruction, and the commonest reason an attempt writes nothing is
         * that its model answered in prose. Jumping the whole tier on the first one spent a stronger role on
         * something the role's own second model would have done: measured on a real 94-task board, 41 no-op
         * attempts pushed tasks to attempt counts of 6, 8 and 12 — every one of them running at council tier,
         * with the plain coder completing only 4 of the 28 finished tasks.
         *
         * So: one more model at this tier, then escalate. Two models producing nothing is the role, not the
         * model, and `tierOf` must not be allowed to grind through the rest of the tier proving it.
         */
        const tierStart = Math.floor(attempts / deps.rounds) * deps.rounds;
        const target = attempts === tierStart ? attempts + 1 : tierStart + deps.rounds;
        while (board.get(taskId)!.attempts < target) board.incrementAttempts(taskId);
      } else {
        board.incrementAttempts(taskId); // fail → tier advances
      }
      continue;
    }

    // tier 2 — escalation council
    let v: Verdict;
    try {
      v = await runEscalationCouncil(deps, board, taskId, cwd, family);
    } catch (e) {
      if (deps.signal.aborted) throw e;
      v = attemptError(board, taskId, "code-reviewer", e); // council threw → treat as a failed council round
    }
    if (v.verdict === "pass") {
      board.clearReviewNotes(taskId);
      board.move(taskId, "DONE", "code-reviewer");
      return v;
    }

    // council fail → ask the human
    const decision = await deps.askHuman({ card: board.get(taskId)!, verdict: v });
    if (decision.action === "accept") {
      board.appendStage(taskId, { role: "human", action: "human:accept" });
      board.clearReviewNotes(taskId);
      board.move(taskId, "DONE", "human");
      return { verdict: "pass", notes: [] };
    }
    if (decision.action === "retry") {
      board.appendStage(taskId, {
        role: "human",
        action: "human:retry",
        note: decision.notes.join("; "),
      });
      board.clearReviewNotes(taskId);
      for (const n of decision.notes) board.addReviewNote(taskId, n);
      board.incrementAttempts(taskId); // stays at tier 2, council retries
      continue;
    }
    // abandon
    board.appendStage(taskId, { role: "human", action: "human:abandon" });
    return { verdict: "fail", notes: v.notes };
  }
}
