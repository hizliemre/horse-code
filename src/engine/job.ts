import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { RevisionPRAdapter } from "../adapters/pr.js";
import type { ReviewDeps, AskUser } from "./review.js";
import type { AskHuman } from "./escalation.js";
import { readOnlyRegistry } from "./reviewer.js";
import { runUpstream } from "./upstream.js";
import { runProjectManager } from "./project-manager.js";
import { runWaves } from "./wave-engine.js";
import type { WaveEngineResult } from "./wave-engine.js";
import { runRevision, type RevisionResult } from "./revision.js";

export interface JobDeps extends ReviewDeps {
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  rounds: number;
  askHuman: AskHuman;
}

export type JobResult =
  | { kind: "chat"; response: string }
  | { kind: "rejected"; stage: "spec" | "plan" }
  | { kind: "done"; wave: WaveEngineResult; revision?: RevisionResult; report: string; session: WorktreeSession };

function pmOpts(deps: JobDeps, workdir: string, planPath: string): RoleAgentOptions {
  const { model, systemPrompt } = deps.roleRegistry.resolve("project-manager");
  return {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `"${planPath}" plan'ını oku ve gerçek task'lara böl (id, title, deps).` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
}

async function runCoachReport(deps: JobDeps, session: WorktreeSession, board: Board): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  const summary = board
    .list()
    .map((c) => `- ${c.id} "${c.title}" [${c.column}]: ${c.stageHistory.map((s) => s.action).join(", ")}`)
    .join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `İş tamamlandı. Board durumu:\n${summary}\nKullanıcıya kısa bir final raporu ver (hangi task'ta ne oldu).` }],
    permission: deps.permission, approve: deps.approve, cwd: session.baseWorktree, signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}

/**
 * Üst-katman iş: openSession → runUpstream → (chat/rejected: kapat) → commit spec/plan →
 * project-manager board → runWaves → coach raporu. done'da session açık bırakılır (G revision).
 */
export async function runJob(
  deps: JobDeps,
  opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string; revisionRounds?: number },
): Promise<JobResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  const workdir = session.baseWorktree;
  const up = await runUpstream(deps, workdir, opts.prompt, opts.askUser, opts.maxRounds);

  if (up.kind === "chat") {
    await deps.manager.closeSession(session);
    return { kind: "chat", response: up.response };
  }
  if (up.kind === "rejected") {
    await deps.manager.closeSession(session);
    return { kind: "rejected", stage: up.stage };
  }

  await deps.manager.commitMerge(session, "hc: spec + plan"); // spec/plan → baseBranch (PR'a girer)
  const board = await runProjectManager(pmOpts(deps, workdir, up.planPath));
  const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
  let revision: RevisionResult | undefined;
  if (wave.status === "completed") {
    const prDiff = await deps.manager.diff(session, opts.fromBranch);
    revision = await runRevision(
      deps, session, board,
      (c) => deps.prAdapter.postComments(c),
      opts.askUser, opts.revisionRounds ?? 3, prDiff,
    );
  }
  const report = await runCoachReport(deps, session, board);
  return { kind: "done", wave, revision, report, session };
}
