import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
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
import { snapshotBoard, type ProgressEvent } from "./progress.js";

export interface JobDeps extends ReviewDeps {
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  rounds: number;
  askHuman: AskHuman;
}

export type JobResult =
  | { kind: "chat"; response: string; refinedPrompt?: string }
  | { kind: "rejected"; stage: "spec" | "plan"; refinedPrompt?: string }
  | { kind: "done"; wave: WaveEngineResult; revision?: RevisionResult; report: string; session: WorktreeSession; refinedPrompt?: string };

function pmOpts(deps: JobDeps, workdir: string, planPath: string): RoleAgentOptions {
  const { model, systemPrompt } = deps.roleRegistry.resolve("project-manager");
  return {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `Read the "${planPath}" plan and break it into real tasks (id, title, deps).` }],
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
    messages: [{ role: "user", content: `Work complete. Board state:\n${summary}\nGive the user a short final report (what happened in each task).` }],
    permission: deps.permission, approve: deps.approve, cwd: session.baseWorktree, signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}

/**
 * Top-level job: openSession → runUpstream → (chat/rejected: close) → commit spec/plan →
 * project-manager board → runWaves → coach report. On done, the session is left open (G revision).
 */
export async function runJob(
  deps: JobDeps,
  opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string; revisionRounds?: number; onEvent?: (ev: ProgressEvent) => void; history?: Message[] },
): Promise<JobResult> {
  // don't let onEvent errors crash the engine: the observer is called synchronously (deep inside board mutations).
  const onEvent = opts.onEvent;
  const emit = onEvent ? (ev: ProgressEvent) => { try { onEvent(ev); } catch { /* observer error isolated */ } } : () => {};
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  try {
    const workdir = session.baseWorktree;
    emit({ kind: "phase", phase: "upstream" });
    const up = await runUpstream(deps, workdir, opts.prompt, opts.askUser, opts.maxRounds, opts.history, emit);

    if (up.kind === "chat") {
      emit({ kind: "phase", phase: "chat" });
      await deps.manager.closeSession(session);
      return { kind: "chat", response: up.response, refinedPrompt: up.refinedPrompt };
    }
    if (up.kind === "rejected") {
      emit({ kind: "phase", phase: "rejected", detail: up.stage });
      await deps.manager.closeSession(session);
      return { kind: "rejected", stage: up.stage, refinedPrompt: up.refinedPrompt };
    }

    emit({ kind: "phase", phase: "approved" });
    await deps.manager.commitMerge(session, "hc: spec + plan"); // spec/plan → baseBranch (goes into the PR)

    emit({ kind: "phase", phase: "board" });
    const board = await runProjectManager(pmOpts(deps, workdir, up.planPath));
    emit({ kind: "board", cards: snapshotBoard(board) });
    board.onChange = () => emit({ kind: "board", cards: snapshotBoard(board) });

    emit({ kind: "phase", phase: "waves" });
    const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
    emit({ kind: "phase", phase: "waves-done", detail: wave.status });

    let revision: RevisionResult | undefined;
    if (wave.status === "completed") {
      emit({ kind: "phase", phase: "pr", detail: wave.pr.url });
      const prDiff = await deps.manager.diff(session, opts.fromBranch);
      emit({ kind: "phase", phase: "revision" });
      revision = await runRevision(
        deps, session, board,
        (c) => deps.prAdapter.postComments(c),
        opts.askUser, opts.revisionRounds ?? 3, prDiff,
      );
      emit({ kind: "phase", phase: "revision-done", detail: revision.status });
    }

    emit({ kind: "phase", phase: "report" });
    const report = await runCoachReport(deps, session, board);
    emit({ kind: "phase", phase: "done" });
    return { kind: "done", wave, revision, report, session, refinedPrompt: up.refinedPrompt };
  } catch (e) {
    await deps.manager.closeSession(session).catch(() => {}); // clean up orphan worktree; don't let cleanup errors shadow the original
    throw e;
  }
}
