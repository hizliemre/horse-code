import type { Board, Card } from "../board/board.js";
import { routeTask } from "./routing.js";
import { runCycleWithRole } from "./task-cycle.js";
import { runEscalationCouncil } from "./council.js";
import type { TaskCycleDeps, Verdict, RunnableRole } from "./task-types.js";

export type HumanDecision =
  | { action: "accept" }
  | { action: "retry"; notes: string[] }
  | { action: "abandon" };

export type AskHuman = (ctx: { card: Card; verdict: Verdict }) => Promise<HumanDecision>;

export interface EscalationDeps extends TaskCycleDeps {
  rounds: number; // turns per tier (config escalation.rounds; default 3)
  askHuman: AskHuman;
}

/** Derives the tier from attempts + turns-per-tier: 0 implementer, 1 senior, 2 council. */
export function tierOf(attempts: number, rounds: number): 0 | 1 | 2 {
  return attempts < rounds ? 0 : attempts < 2 * rounds ? 1 : 2;
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
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskWithEscalation: unknown task: ${taskId}`);

  const family = await routeTask(deps, task); // once: coder | designer
  board.setWorktree(taskId, cwd);

  for (;;) {
    const attempts = board.get(taskId)!.attempts;
    const tier = tierOf(attempts, deps.rounds);

    if (tier < 2) {
      const role: RunnableRole =
        tier === 0 ? family : family === "designer" ? "senior-designer" : "senior-coder";
      const v = await runCycleWithRole(deps, board, taskId, cwd, role);
      if (v.verdict === "pass") return v; // runCycleWithRole moved it to DONE
      board.incrementAttempts(taskId); // fail → tier advances
      continue;
    }

    // tier 2 — escalation council
    const v = await runEscalationCouncil(deps, board, taskId, cwd, family);
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
