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
import { clearCheckpoint, readCheckpoint, isContinuePrompt, type Checkpoint } from "./checkpoint.js";
import { snapshotBoard, type ProgressEvent } from "./progress.js";
import { appendReviewNotes } from "./review-notes.js";
import { memoryHints } from "./memory-inject.js";
import { curateMemories } from "./memory-consolidate.js";
import { saveBoard, loadBoard } from "../board/persist.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Card, Column } from "../board/board.js";
import { dirname, join } from "node:path";

/** Human-readable action for a board column transition (chat notes). */
function columnAction(to: Column): string {
  return to === "IN-PROGRESS" ? "In progress" : to === "REVIEW" ? "In review" : to === "DONE" ? "Done ✓" : "Sent back for rework";
}

export interface JobDeps extends ReviewDeps {
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  rounds: number;
  askHuman: AskHuman;
}

export type JobResult =
  | { kind: "chat"; response: string; refinedPrompt?: string; nextSteps?: string[]; rules?: string[]; remembered?: string[]; lessons?: string[] }
  | { kind: "rejected"; stage: "spec" | "plan"; refinedPrompt?: string }
  | { kind: "done"; wave: WaveEngineResult; revision?: RevisionResult; report: string; session: WorktreeSession; refinedPrompt?: string };

function pmOpts(deps: JobDeps, workdir: string, tasksPath: string): RoleAgentOptions {
  const resolved = deps.roleRegistry.resolve("project-manager");
  const hints = memoryHints(deps, `task breakdown ${tasksPath}`, { role: "project-manager" });
  return {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [...(hints.message ? [{ role: "user" as const, content: hints.message }] : []), { role: "user", content:
      `Read the "${tasksPath}" task list and turn it into board tasks (id, title, deps, acceptance).\n\n` +
      `For EACH task also write its \`acceptance\` — 2-4 concrete statements that will be OBSERVABLY true when ` +
      `the task is done, each checkable by reading the worktree: a named file exists and exports/contains X, a ` +
      `specific behavior is covered by a test, a config key is set. They are the completion gate: a task is only ` +
      `marked done when these are verified. Write conditions, not restatements of the title — ` +
      `"src/models/todo.ts defines a Todo type with id, title, done" is a criterion; "the model is implemented" is not.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
}

/**
 * Runs the memory curator over everything this job produced. Review agents only ever PROPOSE; this is the one
 * place any of it can become a stored memory. Best-effort by design — memory is advisory, so a failed curation
 * must never turn a finished job into a failed one, nor mask the error that ended a failed one.
 */
async function curate(deps: JobDeps, request: string, cards: Card[], deferred: string[], cwd: string): Promise<void> {
  try {
    const proposals = deps.proposals?.drain() ?? [];
    if (proposals.length === 0 && cards.length === 0) return;
    await curateMemories(
      deps,
      { request, cards, ...(deferred.length ? { deferred } : {}), ...(proposals.length ? { proposals } : {}) },
      cwd,
      [...deps.roleRegistry.names(), ...deps.council.map((c) => c.name),
        ...(["spec", "plan", "code"] as const).flatMap((s) => deps.teams[s].map((c) => c.name))],
      (deps.memory?.() ?? []).map((m) => m.text),
    );
  } catch { /* never blocks, and never masks a job error */ }
}

async function runCoachReport(deps: JobDeps, session: WorktreeSession, board: Board): Promise<string> {
  const resolved = deps.roleRegistry.resolve("coach");
  const summary = board
    .list()
    .map((c) => `- ${c.id} "${c.title}" [${c.column}]: ${c.stageHistory.map((s) => s.action).join(", ")}`)
    .join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
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
    if (!session) {
      // Resume: reuse a preserved worktree from an earlier interrupted run of the same prompt (so the user
      // continues from where they left off — even after restarting hcode); otherwise open a fresh session.
      session = (await deps.manager.findResumable(opts.prompt))
        ?? await deps.manager.openSession(opts.fromBranch, nameHint || opts.jobName);
      if (session.resumed) emit({ kind: "note", text: `⏩ Resuming earlier work at \`${session.baseWorktree}\` — completed phases are skipped.` });
    }
    return session.baseWorktree;
  };
  // A bare "continue" request (e.g. "kaldığımız yerden devam edelim") resumes the most recent preserved work
  // WITHOUT re-running the refiner: adopt its worktree + checkpoint up front so the pipeline drives from it.
  let resume: Checkpoint | undefined;
  if (isContinuePrompt(opts.prompt)) {
    const resumable = await deps.manager.findResumable(opts.prompt);
    const cp = resumable ? readCheckpoint(resumable.root) : null;
    if (resumable && cp) {
      const at = cp.done.length ? `already done: ${cp.done.join(", ")}` : "nothing finished yet";
      session = resumable;
      resume = cp;
      emit({ kind: "note", text: `⏩ Resuming "${cp.title}" at \`${resumable.baseWorktree}\` — ${at}.` });
    } else {
      // "continue" is never a request to START something. Falling through here used to hand the word itself to
      // the refiner, which dutifully classified it as a feature and scaffolded a whole new project out of it —
      // an empty worktree that then competed with the real work for the NEXT resume.
      return { kind: "chat", response:
        "There is no preserved work to continue — no resumable worktree with a checkpoint was found in this " +
        "project. Tell me what to work on and I'll start it, or re-send the original request to pick it up." };
    }
  }
  try {
    emit({ kind: "phase", phase: "upstream" });
    const up = await runUpstream(deps, ensureWorktree, opts.prompt, opts.askUser, opts.maxRounds, opts.history, emit, opts.images, resume);

    if (up.kind === "chat") {
      // The "chat" phase is emitted inside runUpstream (right before the coach runs) so the UI shows the
      // coach-waiting status while the coach actually works — no re-emit here.
      // No worktree was opened for a chat turn — nothing to close.
      return { kind: "chat", response: up.response, refinedPrompt: up.refinedPrompt, nextSteps: up.nextSteps, rules: up.rules, remembered: up.remembered, lessons: up.lessons };
    }
    if (up.kind === "rejected") {
      emit({ kind: "phase", phase: "rejected", detail: up.stage });
      // Don't discard the rejected draft: commit it to its branch (so the work survives) and tell the user
      // how to inspect it, instead of silently deleting the worktree + branch.
      if (session) {
        clearCheckpoint(session.root); // user rejected → a terminal state; don't auto-resume it next run
        const dir = await deps.manager.preserveSession(session, `hc: rejected ${up.stage} draft`);
        emit({ kind: "note", text: `📄 The rejected ${up.stage} draft is kept at \`${dir}\` (branch \`${session.baseBranch}\`) — inspect the files there.` });
      }
      return { kind: "rejected", stage: up.stage, refinedPrompt: up.refinedPrompt };
    }

    // Approved → the pipeline opened the worktree via ensureWorktree.
    if (!session) throw new Error("runJob: approved without an open worktree");
    const workdir = session.baseWorktree;
    emit({ kind: "phase", phase: "approved" });
    await deps.manager.commitMerge(session, "hc: spec + plan"); // spec/plan → baseBranch (goes into the PR)

    emit({ kind: "phase", phase: "board" });
    // The board carries the ONLY record of which tasks are already implemented and merged. Without persisting
    // it, a resumed run rebuilds an empty board and re-implements every finished task. It lives next to the
    // checkpoint (outside the git tree) and is rewritten on every mutation.
    const boardPath = join(session.root, "board.json");
    let board: Board;
    if (existsSync(boardPath)) {
      board = await loadBoard(boardPath);
      const done = board.list().filter((c) => c.column === "DONE").length;
      emit({ kind: "note", text: `⏩ Resuming the board — ${done}/${board.list().length} task(s) already done.` });
    } else {
      board = await runProjectManager(pmOpts(deps, workdir, up.tasksPath));
      await saveBoard(board, boardPath);
    }
    emit({ kind: "board", cards: snapshotBoard(board) });
    board.onChange = () => { emit({ kind: "board", cards: snapshotBoard(board) }); void saveBoard(board, boardPath).catch(() => { /* persistence is best-effort */ }); };
    // The chat shows task progress as ACTIONS (transitions), not a kanban board. One note per real column move.
    board.onMove = (card, _from, to) => emit({ kind: "note", text: `📋 **${card.title}** → ${columnAction(to)}` });

    emit({ kind: "phase", phase: "waves" });
    const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
    emit({ kind: "phase", phase: "waves-done", detail: wave.status });

    let revision: RevisionResult | undefined;
    let deferredAll: string[] = [];
    if (wave.status === "completed") {
      emit({ kind: "phase", phase: "pr", detail: wave.pr.url });
      const prDiff = await deps.manager.diff(session, opts.fromBranch);
      // Non-blocking code findings the per-task reviews deferred: a passed task has no further attempt, so the
      // PR revision pass is where they are adjudicated — once, on the merged result.
      const deferred = board.list().flatMap((c) => c.stageHistory.filter((h) => h.action === "deferred").map((h) => h.note ?? "").filter(Boolean));
      deferredAll = deferred; // also handed to the post-job memory extractor as evidence
      if (deferred.length) {
        appendReviewNotes(join(workdir, dirname(up.specPath)), deferred);
        emit({ kind: "note", text: `📝 ${deferred.length} deferred code note(s) handed to the PR revision pass (and recorded in review-notes.md).` });
      }
      emit({ kind: "phase", phase: "revision" });
      revision = await runRevision(
        deps, session, board,
        (c) => deps.prAdapter.postComments(c),
        opts.askUser, opts.revisionRounds ?? 3, prDiff, deferred,
      );
      emit({ kind: "phase", phase: "revision-done", detail: revision.status });
    }

    await curate(deps, up.refinedPrompt ?? opts.prompt, board.list(), deferredAll, session.baseWorktree);

    emit({ kind: "phase", phase: "report" });
    const report = await runCoachReport(deps, session, board);
    clearCheckpoint(session.root); // whole job succeeded → nothing left to resume
    await rm(join(session.root, "board.json"), { force: true }).catch(() => { /* best-effort */ });
    emit({ kind: "phase", phase: "done" });
    return { kind: "done", wave, revision, report, session, refinedPrompt: up.refinedPrompt };
  } catch (e) {
    // Keep the worktree on error so the user can inspect whatever the pipeline produced before it failed
    // (files are already committed per-write). Don't closeSession — that would delete them.
    if (session) emit({ kind: "note", text: `📄 Work so far is kept at \`${session.baseWorktree}\` (branch \`${session.baseBranch}\`). Re-run the same request to resume from where it stopped.` });
    // Curate on the way out too: the runs that FAIL are the most instructive ones, and their proposals live
    // only in process memory — rethrowing without curating would throw away exactly the hardest-won signal.
    if (session) await curate(deps, opts.prompt, [], [], session.baseWorktree);
    throw e;
  }
}
