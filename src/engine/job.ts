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
  | { kind: "chat"; response: string; refinedPrompt?: string; nextSteps?: string[] }
  | { kind: "rejected"; stage: "spec" | "plan"; refinedPrompt?: string }
  | { kind: "done"; wave: WaveEngineResult; revision?: RevisionResult; report: string; session: WorktreeSession; refinedPrompt?: string };

function pmOpts(deps: JobDeps, workdir: string, tasksPath: string): RoleAgentOptions {
  const { model, systemPrompt } = deps.roleRegistry.resolve("project-manager");
  return {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `Read the "${tasksPath}" task list and turn it into board tasks (id, title, deps).` }],
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
  opts: { prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string; revisionRounds?: number; onEvent?: (ev: ProgressEvent) => void; history?: Message[]; images?: string[] },
): Promise<JobResult> {
  // don't let onEvent errors crash the engine: the observer is called synchronously (deep inside board mutations).
  const onEvent = opts.onEvent;
  const emit = onEvent ? (ev: ProgressEvent) => { try { onEvent(ev); } catch { /* observer error isolated */ } } : () => {};
  // Lazy worktree: opened only when the pipeline actually needs to write files (the analyst's spec).
  // A plain chat turn never calls this → no worktree is created for chat.
  let session: WorktreeSession | undefined;
  // nameHint = the refiner's short English title → a meaningful worktree name; falls back to the job name
  // (raw-prompt slug) only if the refiner produced no title.
  const ensureWorktree = async (nameHint?: string): Promise<string> => {
    if (!session) session = await deps.manager.openSession(opts.fromBranch, nameHint || opts.jobName);
    return session.baseWorktree;
  };
  try {
    emit({ kind: "phase", phase: "upstream" });
    const up = await runUpstream(deps, ensureWorktree, opts.prompt, opts.askUser, opts.maxRounds, opts.history, emit, opts.images);

    if (up.kind === "chat") {
      // The "chat" phase is emitted inside runUpstream (right before the coach runs) so the UI shows the
      // coach-waiting status while the coach actually works — no re-emit here.
      // No worktree was opened for a chat turn — nothing to close.
      return { kind: "chat", response: up.response, refinedPrompt: up.refinedPrompt, nextSteps: up.nextSteps };
    }
    if (up.kind === "rejected") {
      emit({ kind: "phase", phase: "rejected", detail: up.stage });
      if (session) await deps.manager.closeSession(session);
      return { kind: "rejected", stage: up.stage, refinedPrompt: up.refinedPrompt };
    }

    // Approved → the pipeline opened the worktree via ensureWorktree.
    if (!session) throw new Error("runJob: approved without an open worktree");
    const workdir = session.baseWorktree;
    emit({ kind: "phase", phase: "approved" });
    await deps.manager.commitMerge(session, "hc: spec + plan"); // spec/plan → baseBranch (goes into the PR)

    emit({ kind: "phase", phase: "board" });
    const board = await runProjectManager(pmOpts(deps, workdir, up.tasksPath));
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
    if (session) await deps.manager.closeSession(session).catch(() => {}); // clean up orphan worktree; don't shadow the original
    throw e;
  }
}
