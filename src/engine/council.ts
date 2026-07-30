import { z } from "zod";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runReviewer, readOnlyRegistry } from "./reviewer.js";
import { runImplementer } from "./implementer.js";
import type { TaskCycleDeps, Verdict, ImplementerRole } from "./task-types.js";
import { worktreeState, hasWorkAgainst } from "./worktree-state.js";
import { defaultGitRunner } from "../worktree/git.js";
import { telemetry } from "../obs/telemetry.js";

export const ArchitectPlanSchema = z.object({
  rootCause: z.string(),
  plan: z.array(z.string()),
});

/**
 * Escalation council (top of the ladder): architect produces root cause + plan →
 * the family's senior applies the plan in the worktree → code-reviewer does a final review.
 * Returns the council round's Verdict; DONE/human decision lives in the calling layer (runTaskWithEscalation).
 */
export async function runEscalationCouncil(
  deps: TaskCycleDeps,
  board: Board,
  taskId: string,
  cwd: string,
  family: ImplementerRole,
): Promise<Verdict> {
  const task = board.get(taskId)!;

  // 1. architect diagnosis (read-only, structured)
  const resolved = deps.roleRegistry.resolve("architect");
  const history = task.stageHistory.map((s) => s.action).join(", ");
  const diagnoseOpts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [
      {
        role: "user",
        content:
          `Task "${task.title}" keeps bouncing back from review.\n` +
          `Reviewer notes:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}\n` +
          `History: ${history}\nIdentify the root cause and produce a concrete plan.`,
      },
    ],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const plan = await runStructuredRole(diagnoseOpts, ArchitectPlanSchema);
  board.appendStage(taskId, { role: "architect", action: "council:diagnosed", note: plan.rootCause });

  // 2. senior implement — the plan is written to reviewNotes (E3a "returning task" path)
  const senior = family === "designer" ? "senior-designer" : "senior-coder";
  board.clearReviewNotes(taskId);
  board.addReviewNote(taskId, plan.rootCause);
  for (const step of plan.plan) board.addReviewNote(taskId, step);
  board.move(taskId, "IN-PROGRESS", senior);
  board.setWorker(taskId, senior, deps.roleRegistry.peekModel(senior)); // surface who is working it in the live-agents UI
  /**
   * The council's senior gets the same no-change check as every other implementer.
   *
   * It did not have one: it moved to REVIEW whatever happened. Measured live — five tasks each ran a
   * council implementation of one turn and ZERO tool calls, went to review with an unchanged worktree, and
   * the reviewer spent all 25 of its turns looking for a change that was not there before failing with
   * "tool call budget exceeded before review could be conducted". Every one of those reviews was pure cost:
   * there was nothing to judge.
   */
  const before = await worktreeState(defaultGitRunner, cwd);
  await runImplementer(deps, senior, board.get(taskId)!, cwd);
  const after = await worktreeState(defaultGitRunner, cwd);
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
    && !(deps.baseRef && await hasWorkAgainst(defaultGitRunner, cwd, deps.baseRef));
  if (idle) {
    const served = deps.roleRegistry.chainFor(senior, 0)[0] ?? "";
    telemetry().event("implementer.no_changes", {
      "hc.task.id": taskId, "hc.role": senior, "hc.model": served, "hc.council": true,
    });
    if (served) deps.fitness?.record(senior, served, "answered in prose instead of implementing");
    board.appendStage(taskId, { role: senior, action: "no-changes", note: served ? `model: ${served}` : undefined });
    board.move(taskId, "TODO", senior);
    deps.note?.(`⚠️ **${board.get(taskId)!.title}** — the council's \`${senior}\` wrote nothing; not sending an unchanged worktree to review.`);
    return { verdict: "fail", notes: [
      "The council's implementation produced NO file changes. Write the code with write_file/edit_file — describing it is not enough.",
    ] };
  }
  board.appendStage(taskId, { role: senior, action: "council:implemented" });
  board.move(taskId, "REVIEW", senior);

  // 3. final review
  /**
   * The council's review is a review, and the timings must say so.
   *
   * Only the normal cycle's team review was wrapped in a span, so a task that reached the council — which is
   * every task that has failed a few times, i.e. exactly the ones a run gets stuck on — spent its review time
   * invisibly. A live run showed `code review 0m/0x` while tasks were passing review and merging, and the
   * "where did the slot time go" report had nothing to say about the stage that was actually running.
   */
  const v = await telemetry().span("stage.code_review", {
    "hc.stage": "code review", "hc.task.id": taskId, "hc.council": true,
  }, () => runReviewer(deps, board.get(taskId)!, cwd));
  if (v.verdict === "pass") {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" });
  } else {
    board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:fail", note: v.notes.join("; ") });
  }
  return v;
}
