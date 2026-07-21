import { z } from "zod";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { AskUser } from "./review.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry } from "./reviewer.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";

export interface RevisionDeps extends TaskCycleDeps {
  manager: Pick<WorktreeManager, "commitMerge" | "push">;
}
export type PostComments = (comments: string[]) => Promise<void>;

export const PrincipalReviewSchema = z.object({
  decision: z.enum(["approve", "request-changes"]),
  comments: z.array(z.string()),
});
export const PrincipalFinalSchema = z.object({
  decision: z.enum(["accept", "ask-human"]),
  question: z.string(),
});

/**
 * Revision result. `rounds` semantics vary by variant:
 * - `approved`: number of revision rounds done BEFORE approval (approval on round 1 → 0).
 * - `accepted`/`human`: number of rounds reached (= clamped maxRounds, number of principal reviews).
 */
export type RevisionResult =
  | { status: "approved"; rounds: number }
  | { status: "accepted"; rounds: number }
  | { status: "human"; rounds: number; answer: string };

async function principalReview(deps: RevisionDeps, base: string, prDiff?: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const content = prDiff
    ? `PR review: review the following diff:\n${prDiff}\n(use the read tools to inspect the worktree if needed.) Give approve or request-changes + concrete comments.`
    : "PR review: review all changes in the base worktree holistically. Give approve or request-changes + concrete comments.";
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalReviewSchema);
}

async function principalFinal(deps: RevisionDeps, base: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: "FINAL DECISION: Revision rounds are over and findings still remain. Give accept or ask-human (a question to ask the user)." }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalFinalSchema);
}

async function seniorRevise(deps: RevisionDeps, base: string, comments: string[]): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("senior-coder");
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content: `PR revision: address the following comments (fix them or justify as "by design"), work in the main worktree:\n${comments.map((c) => `- ${c}`).join("\n")}` }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  await runToCompletion(opts);
}

/**
 * Revision loop: principal review → approve: done / request-changes: postComments + senior
 * fixes it + commit/push → re-review. ≤maxRounds; if findings remain on the last round → principal makes the final call.
 */
export async function runRevision(
  deps: RevisionDeps,
  session: WorktreeSession,
  board: Board,
  postComments: PostComments,
  askUser: AskUser,
  maxRounds: number,
  prDiff?: string,
): Promise<RevisionResult> {
  board.addCard({ id: "__revision__", title: "PR revision" });
  const base = session.baseWorktree;
  const rounds = Math.max(1, maxRounds);

  for (let round = 1; round <= rounds; round++) {
    const v = await principalReview(deps, base, prDiff);
    if (v.decision === "approve") {
      board.appendStage("__revision__", { role: "principal-coder", action: "pr:approved" });
      return { status: "approved", rounds: round - 1 };
    }
    board.appendStage("__revision__", { role: "principal-coder", action: "pr:changes", note: v.comments.join("; ") });

    if (round === rounds) {
      const f = await principalFinal(deps, base);
      if (f.decision === "accept") {
        board.appendStage("__revision__", { role: "principal-coder", action: "pr:final:accept" });
        return { status: "accepted", rounds };
      }
      const answer = await askUser(f.question);
      board.appendStage("__revision__", { role: "human", action: "pr:human", note: answer });
      return { status: "human", rounds, answer };
    }

    await postComments(v.comments);
    await seniorRevise(deps, base, v.comments);
    board.appendStage("__revision__", { role: "senior-coder", action: "pr:revised" });
    await deps.manager.commitMerge(session, `hc: revision ${round}`);
    await deps.manager.push(session);
  }
  // unreachable (rounds ≥ 1 → the last iteration always returns); for type safety:
  return { status: "accepted", rounds };
}
