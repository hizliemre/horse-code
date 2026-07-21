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
 * Revision sonucu. `rounds` semantiği varyanta göre değişir:
 * - `approved`: onaydan ÖNCE yapılan revizyon turu sayısı (ilk turda onay → 0).
 * - `accepted`/`human`: ulaşılan tur sayısı (= clamp'lenmiş maxRounds, principal review sayısı).
 */
export type RevisionResult =
  | { status: "approved"; rounds: number }
  | { status: "accepted"; rounds: number }
  | { status: "human"; rounds: number; answer: string };

async function principalReview(deps: RevisionDeps, base: string, prDiff?: string) {
  const { model, systemPrompt } = deps.roleRegistry.resolve("principal-coder");
  const content = prDiff
    ? `PR review: şu diff'i incele:\n${prDiff}\n(gerekirse read-tool'larla worktree'yi de incele.) approve veya request-changes + somut comment'ler ver.`
    : "PR review: base worktree'deki tüm değişiklikleri bütünsel incele. approve veya request-changes + somut comment'ler ver.";
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
    messages: [{ role: "user", content: "SON KARAR: Revizyon turları bitti, hâlâ bulgu var. accept (kabul) veya ask-human (kullanıcıya sorulacak soru) ver." }],
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
    messages: [{ role: "user", content: `PR revizyonu: şu yorumları gider (fix et veya "by design" gerekçele), ana worktree'de çalış:\n${comments.map((c) => `- ${c}`).join("\n")}` }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  await runToCompletion(opts);
}

/**
 * Revision döngüsü: principal review → approve:biter / request-changes: postComments + senior
 * düzeltir + commit/push → re-review. ≤maxRounds; son turda hâlâ bulgu → principal son karar.
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
  // erişilmez (rounds ≥ 1 → son iterasyon her zaman döner); tip güvenliği:
  return { status: "accepted", rounds };
}
