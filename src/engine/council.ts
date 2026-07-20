import { z } from "zod";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runReviewer, readOnlyRegistry } from "./reviewer.js";
import { runImplementer } from "./implementer.js";
import type { TaskCycleDeps, Verdict, ImplementerRole } from "./task-types.js";

export const ArchitectPlanSchema = z.object({
  rootCause: z.string(),
  plan: z.array(z.string()),
});

/**
 * Escalation konseyi (merdivenin tepesi): architect kök-neden + plan üretir →
 * ailenin senior'ı planı worktree'de uygular → code-reviewer son review.
 * Konsey turunun Verdict'ini döner; DONE/insan kararı çağıran katmanda (runTaskWithEscalation).
 */
export async function runEscalationCouncil(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  cwd: string,
  family: ImplementerRole,
): Promise<Verdict> {
  const task = board.get(taskId)!;

  // 1. architect diagnoz (salt-okunur, structured)
  const { model, systemPrompt } = deps.roleRegistry.resolve("architect");
  const history = task.stageHistory.map((s) => s.action).join(", ");
  const diagnoseOpts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [
      {
        role: "user",
        content:
          `Task "${task.title}" tekrar tekrar review'dan döndü.\n` +
          `Reviewer notları:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}\n` +
          `Geçmiş: ${history}\nKök-nedeni belirle ve somut bir plan üret.`,
      },
    ],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const plan = await runStructuredRole(diagnoseOpts, ArchitectPlanSchema);
  board.appendStage(taskId, { role: "architect", action: "council:diagnosed", note: plan.rootCause });

  // 2. senior implement — plan reviewNotes'a yazılır (E3a "dönen task" yolu)
  const senior = family === "designer" ? "senior-designer" : "senior-coder";
  board.clearReviewNotes(taskId);
  board.addReviewNote(taskId, plan.rootCause);
  for (const step of plan.plan) board.addReviewNote(taskId, step);
  board.move(taskId, "IN-PROGRESS", senior);
  await runImplementer(deps, senior, board.get(taskId)!, cwd);
  board.appendStage(taskId, { role: senior, action: "council:implemented" });
  board.move(taskId, "REVIEW", senior);

  // 3. son review
  const v = await runReviewer(deps, board.get(taskId)!, cwd);
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
  } else {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:fail", note: v.notes.join("; ") });
  }
  return v;
}
