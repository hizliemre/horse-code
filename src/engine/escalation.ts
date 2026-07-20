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
  rounds: number; // tier başına tur (config escalation.rounds; varsayılan 3)
  askHuman: AskHuman;
}

/** attempts + tier başına tur sayısından tier: 0 implementer, 1 senior, 2 konsey. */
export function tierOf(attempts: number, rounds: number): 0 | 1 | 2 {
  return attempts < rounds ? 0 : attempts < 2 * rounds ? 1 : 2;
}

/**
 * Task-seviyesi escalation merdiveni: route→aile, tier(attempts/N) ile rol yükseltme
 * (implementer → senior → konsey). Konsey de çözemezse askHuman seam'i (accept/retry/abandon).
 */
export async function runTaskWithEscalation(
  deps: EscalationDeps,
  board: Board,
  taskId: string,
  cwd: string,
): Promise<Verdict> {
  const task = board.get(taskId);
  if (!task) throw new Error(`runTaskWithEscalation: bilinmeyen task: ${taskId}`);

  const family = await routeTask(deps, task); // bir kez: coder | designer
  board.setWorktree(taskId, cwd);

  for (;;) {
    const attempts = board.get(taskId)!.attempts;
    const tier = tierOf(attempts, deps.rounds);

    if (tier < 2) {
      const role: RunnableRole =
        tier === 0 ? family : family === "designer" ? "senior-designer" : "senior-coder";
      const v = await runCycleWithRole(deps, board, taskId, cwd, role);
      if (v.verdict === "pass") return v; // runCycleWithRole DONE'a taşıdı
      board.incrementAttempts(taskId); // fail → tier ilerler
      continue;
    }

    // tier 2 — escalation konseyi
    const v = await runEscalationCouncil(deps, board, taskId, cwd, family);
    if (v.verdict === "pass") {
      board.clearReviewNotes(taskId);
      board.move(taskId, "DONE", "code-reviewer");
      return v;
    }

    // konsey fail → insana sor
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
      board.incrementAttempts(taskId); // tier 2'de kalır, konsey tekrar
      continue;
    }
    // abandon
    board.appendStage(taskId, { role: "human", action: "human:abandon" });
    return { verdict: "fail", notes: v.notes };
  }
}
