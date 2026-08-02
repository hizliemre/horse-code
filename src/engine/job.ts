import { runToCompletion } from "../agent/loop.js";
import { stripThinking } from "../tui/format.js";
import { recordTurn } from "./turn-effect.js";
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
import { auditBreakdown, repairRequest } from "./task-audit.js";
import { runWaves } from "./wave-engine.js";
import type { WaveEngineResult } from "./wave-engine.js";
import { REVISION_CARD, runRevision, type RevisionResult } from "./revision.js";
import { clearCheckpoint, readCheckpoint, isContinuePrompt, type Checkpoint } from "./checkpoint.js";
import { describeInherited, describeTopUp } from "../worktree/inherit.js";
import { snapshotBoard, type ProgressEvent } from "./progress.js";
import { appendReviewNotes } from "./review-notes.js";
import { memoryHints } from "./memory-inject.js";
import { curateMemories } from "./memory-consolidate.js";
import { saveBoard, loadBoard, flushBoard } from "../board/persist.js";
import { existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import type { Card, Column } from "../board/board.js";
import { dirname, join } from "node:path";

/** Human-readable action for a board column transition (chat notes). */
/**
 * A board transition, said as what happened to WHOM.
 *
 * The chat used to read "📋 **task** → In progress" — true, and silent about the five agents running at
 * once. With the tool flood moved onto the agent rows, this is what the conversation is FOR: who picked up
 * what, and who finished it.
 */
function moveNote(card: Card, to: Column, actor?: string): string {
  const who = actor ?? card.role;
  const title = `**${card.title}**`;
  if (to === "IN-PROGRESS") return `🤖 ${who ? `\`${who}\` picked up ${title}` : `${title} → in progress`}`;
  if (to === "REVIEW") return `🔍 ${title} — ${who ? `\`${who}\` handed it to review` : "in review"}`;
  if (to === "DONE") return `✅ ${who ? `\`${who}\` finished ${title}` : `${title} — reviewed`}`;
  // Landing is a separate event from finishing, and the one that means the work was delivered.
  if (to === "MERGED") return `🚢 ${title} — merged into the base branch`;
  // Said plainly: a card nobody is going to pick up should not read like one that is waiting for a slot.
  if (to === "ABANDONED") return `🛑 ${title} — nothing left that could change it`;
  // Parking is a pause with a reason, not a verdict — the reason is on the card and is what wakes it.
  if (to === "PARKED") return `⏸ ${title} — parked; it will be retried when the ground moves`;
  return `↩︎ ${title} — sent back for rework`;
}

export interface JobDeps extends ReviewDeps {
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  rounds: number;
  askHuman: AskHuman;
  /** How many tasks of one wave may run at once (see MAX_PARALLEL_TASKS). */
  maxParallel?: number;
}

export type JobResult =
  | { kind: "chat"; response: string; refinedPrompt?: string; nextSteps?: string[]; rules?: string[]; remembered?: string[]; lessons?: string[] }
  | { kind: "rejected"; stage: "spec" | "plan"; refinedPrompt?: string }
  | { kind: "done"; wave: WaveEngineResult; revision?: RevisionResult; report: string; session: WorktreeSession; refinedPrompt?: string }
  /** Governance work: written in place, no worktree, no branch, nothing to merge. */
  | { kind: "governed"; path: string; written: boolean; refinedPrompt?: string }
  /** The previous turn's writes, put back. */
  | { kind: "undone"; report: string; refinedPrompt?: string };

function pmOpts(deps: JobDeps, workdir: string, tasksPath: string): RoleAgentOptions {
  const resolved = deps.roleRegistry.resolve("project-manager");
  const hints = memoryHints(deps, `task breakdown ${tasksPath}`, { role: "project-manager" });
  return {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [...(hints.message ? [{ role: "user" as const, content: hints.message }] : []), { role: "user", content:
      `Read the "${tasksPath}" task list and turn it into board tasks (id, title, deps, acceptance, files).\n\n` +
      `For EACH task also write its \`acceptance\` — 2-4 concrete statements that will be OBSERVABLY true when ` +
      `the task is done, each checkable by reading the worktree: a named file exists and exports/contains X, a ` +
      `specific behavior is covered by a test, a config key is set. They are the completion gate: a task is only ` +
      `marked done when these are verified. Write conditions, not restatements of the title — ` +
      `"src/models/todo.ts defines a Todo type with id, title, done" is a criterion; "the model is implemented" is not.\n\n` +
      `Also give each task its \`files\` — the repo-relative paths it will create or modify, taken from the task ` +
      `list (which already names them). List every file the task writes, including its test file. This decides ` +
      `what may run in parallel: two tasks that write the same file are not independent, and being wrong about ` +
      `that costs a merge conflict hours later rather than an error now. Do not list files a task only READS.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
}

/** How much of the plan the auditor is given. Long enough for a real plan, short of paying for a whole book. */
const MAX_PLAN_CHARS = 24_000;
/** Turns the breakdown audit may take. It reads a plan it was handed; it does not survey the repository. */
const AUDIT_MAX_TURNS = 8;

/** Undefined when the role is not configured — the structural pass runs regardless; see `auditBreakdown`. */
function auditOpts(deps: JobDeps, workdir: string): RoleAgentOptions | undefined {
  let resolved;
  try { resolved = deps.roleRegistry.resolve("task-auditor"); } catch { return undefined; }
  return {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
    // It may want to open a file the plan names; it has no business exploring for fifty turns. A gate that
    // costs more than the work it guards is not a gate.
    maxTurns: AUDIT_MAX_TURNS,
  };
}

/**
 * The gate the task breakdown never had.
 *
 * A spec and a plan each pass fifteen lenses, a council and a judge; the breakdown that every later hour is
 * spent executing went from the model straight to the board. One repair round, not a loop: the findings are
 * concrete enough that a second pass fixes them or the model cannot, and a loop here would spend the run's
 * budget before a line of code was written.
 */
async function gateBreakdown(
  deps: JobDeps, workdir: string, tasksPath: string, planPath: string,
  emit: (ev: ProgressEvent) => void,
): Promise<Board> {
  let board = await runProjectManager(pmOpts(deps, workdir, tasksPath));
  let planText = "";
  try { planText = (await readFile(join(workdir, planPath), "utf8")).slice(0, MAX_PLAN_CHARS); } catch { /* the audit still runs on structure alone */ }

  const audit = await auditBreakdown(auditOpts(deps, workdir), board, planText);
  if (audit.findings.length === 0) return board;

  emit({ kind: "note", text:
    `🧾 The task breakdown has ${audit.findings.length} problem(s) — sending it back before any of it is built:\n` +
    audit.findings.map((f) => `  · ${f.task ? `${f.task}: ` : ""}${f.issue}`).join("\n") });

  try {
    const opts = pmOpts(deps, workdir, tasksPath);
    board = await runProjectManager({ ...opts, messages: [...opts.messages, { role: "user", content: repairRequest(audit.findings) }] });
  } catch (e) {
    if (deps.signal.aborted) throw e;
    emit({ kind: "note", text: `⚠️ The repaired breakdown did not come back — continuing with the original.` });
    return board;
  }
  // Reported, not re-gated: what survives one targeted repair is not going to fall to a second round, and
  // the run's budget belongs to the implementation.
  const left = await auditBreakdown(auditOpts(deps, workdir), board, planText);
  if (left.findings.length) {
    emit({ kind: "note", text: `🧾 ${left.findings.length} of those are still open after the repair — continuing anyway.` });
  }
  return board;
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
    // The report itself is returned and rendered by the caller; only the working-out is noted.
    ...(deps.note ? { onSay: (t: string, final: boolean) => { if (!final) deps.note?.(t); } } : {}),
  };
  const msg = await runToCompletion(opts);
  // A model that emits its own <think> tags must not leak them into the report the user is handed.
  return stripThinking(msg.content);
}

/**
 * Top-level job: openSession → runUpstream → (chat/rejected: close) → commit spec/plan →
 * project-manager board → runWaves → coach report. On done, the session is left open (G revision).
 */
export async function runJob(
  deps: JobDeps,
  opts: {
    prompt: string; fromBranch: string; jobName: string; askUser: AskUser; maxRounds: number; prTitle?: string;
    revisionRounds?: number; onEvent?: (ev: ProgressEvent) => void; history?: Message[]; images?: string[];
    /**
     * The request whose preserved worktree this run should adopt, when it is not the prompt itself.
     *
     * A correction after an interruption — "that answer was wrong, do X instead" — is a DIFFERENT request
     * against the SAME work. Matching a worktree by the prompt alone cannot express that, so the key is
     * passed separately: `prompt` is what the pipeline builds from, `resumeKey` is what it reopens.
     */
    resumeKey?: string;
  },
): Promise<JobResult> {
  // don't let onEvent errors crash the engine: the observer is called synchronously (deep inside board mutations).
  const onEvent = opts.onEvent;
  const emit = onEvent ? (ev: ProgressEvent) => { try { onEvent(ev); } catch { /* observer error isolated */ } } : () => {};
  // Lazy worktree: opened only when the pipeline actually needs to write files (the analyst's spec).
  // A plain chat turn never calls this → no worktree is created for chat.
  let session: WorktreeSession | undefined;
  // nameHint = the refiner's short English title → a meaningful worktree name; falls back to the job name
  // (raw-prompt slug) only if the refiner produced no title.
  /**
   * Adopting a session — the ONE place that does it, because the bookkeeping was forgettable and was forgotten.
   *
   * `ensureWorktree` announced the session and pointed the memory store at it; the resume path assigned
   * `session` directly and did neither. Measured on a real "devam" run: the session's memory.jsonl was never
   * written after it was copied, while the project's gained two new entries and 325 injections in the same
   * hour — the exact failure the retarget was written to fix, reappearing through the door it did not cover.
   */
  const adopt = (s: WorktreeSession): WorktreeSession => {
    session = s;
    // From here the session owns the project's state: what the run learns has to land in what ships.
    deps.onSession?.(s.baseWorktree);
    return s;
  };

  const ensureWorktree = async (nameHint?: string): Promise<string> => {
    if (!session) {
      /**
       * Opening the session is WORK, and it was narrated as something else.
       *
       * The status line shows the last phase that was announced. Between the refiner finishing and the first
       * spec-kit phase there is no announcement at all — while a resumable worktree is searched for, a new
       * one is cut, and the project's working state is copied in. For that whole stretch the line kept
       * saying "refining…", naming the refiner's model and its one call, long after the refiner was done.
       * A status that describes finished work reads as a hang.
       */
      emit({ kind: "phase", phase: "worktree" });
      // Resume: reuse a preserved worktree from an earlier interrupted run of the same prompt (so the user
      // continues from where they left off — even after restarting hcode); otherwise open a fresh session.
      const opened = adopt((await deps.manager.findResumable(opts.resumeKey ?? opts.prompt))
        ?? await deps.manager.openSession(opts.fromBranch, nameHint || opts.jobName));
      /**
       * A REVISED request keeps the worktree but not the finished phases.
       *
       * The spec and plan already on disk were derived from the request that was interrupted; carrying them
       * into a corrected one would build the thing the user just said was wrong, while telling them phases
       * were "skipped". The files stay — they are committed, and the branch is the point of resuming — but
       * the pipeline re-derives from what was actually asked for.
       */
      const revised = opts.resumeKey !== undefined && opts.resumeKey !== opts.prompt;
      if (opened.resumed && revised) {
        clearCheckpoint(opened.root);
        emit({ kind: "note", text: `⏩ Keeping the work at \`${opened.baseWorktree}\` — the request changed, so the plan is re-derived.` });
      } else if (opened.resumed) {
        emit({ kind: "note", text: `⏩ Resuming earlier work at \`${opened.baseWorktree}\` — completed phases are skipped.` });
      }
      // What the branch alone would not have given it — see inheritFromRoot.
      const carried = opened.inherited ? describeInherited(opened.inherited) : undefined;
      if (carried) emit({ kind: "note", text: carried });
      // …and, for a resumed session, whatever came into existence after it was opened.
      const topped = describeTopUp(opened.toppedUp ?? []);
      if (topped) emit({ kind: "note", text: topped });
    }
    // `adopt` set it on every path above; the assertion is for the type system, not a claim about runtime.
    return session!.baseWorktree;
  };
  // A bare "continue" request (e.g. "kaldığımız yerden devam edelim") resumes the most recent preserved work
  // WITHOUT re-running the refiner: adopt its worktree + checkpoint up front so the pipeline drives from it.
  let resume: Checkpoint | undefined;
  if (isContinuePrompt(opts.prompt)) {
    const resumable = await deps.manager.findResumable(opts.prompt);
    const cp = resumable ? readCheckpoint(resumable.root) : null;
    if (resumable && cp) {
      const at = cp.done.length ? `already done: ${cp.done.join(", ")}` : "nothing finished yet";
      adopt(resumable);
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
  deps.onProgress = emit; // implementers report per-agent usage/model through the same channel as reviews
  try {
    emit({ kind: "phase", phase: "upstream" });
    const up = await runUpstream(deps, ensureWorktree, opts.prompt, opts.askUser, opts.maxRounds, opts.history, emit, opts.images, resume);

    if (up.kind === "chat") {
      // The "chat" phase is emitted inside runUpstream (right before the coach runs) so the UI shows the
      // coach-waiting status while the coach actually works — no re-emit here.
      // No worktree was opened for a chat turn — nothing to close.
      return { kind: "chat", response: up.response, refinedPrompt: up.refinedPrompt, nextSteps: up.nextSteps, rules: up.rules, remembered: up.remembered, lessons: up.lessons };
    }
    /**
     * Governance work is finished when the document exists — there was never a worktree to close.
     *
     * Returned before the `!session` guard below, which exists to catch an approved pipeline that somehow
     * skipped opening one. Here a missing session is the correct outcome, not a bug.
     */
    if (up.kind === "governed") {
      return { kind: "governed", path: up.path, written: up.written, refinedPrompt: up.refinedPrompt };
    }
    // Undo touched the working tree directly; like govern, there was never a session to close.
    if (up.kind === "undone") return { kind: "undone", report: up.report, refinedPrompt: up.refinedPrompt };
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
      /**
       * A card left mid-flight by the run that died is NOT in progress — nothing is working it.
       *
       * The columns are a record of where each task got to, and the previous process took its workers with
       * it. Left as they were, the agent panel listed four implementers that did not exist, with no role and
       * no model, their clocks counting up from the moment the panel first saw them. Returned to TODO they
       * are simply work still to do, which is what they are; the wave loop re-runs them either way.
       */
      const interrupted = board.list().filter((c) => c.id !== REVISION_CARD
        && (c.column === "IN-PROGRESS" || c.column === "REVIEW"));
      for (const c of interrupted) board.reopen(c.id);
      /**
       * …and the ones that were never tried at all.
       *
       * A task blocked behind a failure is parked `waiting`, and when nothing can wake it the wave engine
       * files it ABANDONED. For THAT run the verdict is earned — nothing was going to change. For the NEXT
       * one it is simply wrong: the user has since fixed the task that failed, and the ten behind it are
       * still buried where a resume does not look.
       *
       * Measured on a real board: 1 failed, 10 blocked, all eleven ABANDONED and every one of them with
       * `attempts: 0`. That counter is the whole distinction — a card that was tried and gave up has a
       * number there, and is left alone.
       */
      const neverTried = board.list().filter((c) => c.id !== REVISION_CARD
        && c.column === "ABANDONED" && (c.attempts ?? 0) === 0);
      /**
       * The revision row is left wherever the last run stopped, and it is not a task, so nothing will ever
       * move it again. Measured after the fix that stopped it being SCHEDULED: the board still reported
       * `IN-PROGRESS 3` while two tasks were running — a count the user reads and reasonably believes.
       */
      const rev = board.get(REVISION_CARD);
      if (rev && rev.column !== "TODO") board.move(REVISION_CARD, "TODO", "team-lead");
      for (const c of neverTried) board.reopen(c.id);
      const done = board.list().filter((c) => c.column === "MERGED").length;
      emit({ kind: "note", text: `⏩ Resuming the board — ${done}/${board.list().length} task(s) already done.` +
        (interrupted.length ? ` ${interrupted.length} was interrupted mid-flight and goes back in the queue.` : "") +
        (neverTried.length ? ` ${neverTried.length} was blocked behind a failure and never tried — back in the queue too.` : "") });
    } else {
      board = await gateBreakdown(deps, workdir, up.tasksPath, up.planPath, emit);
      await saveBoard(board, boardPath);
    }
    emit({ kind: "board", cards: snapshotBoard(board) });
    board.onChange = () => { emit({ kind: "board", cards: snapshotBoard(board) }); void saveBoard(board, boardPath).catch(() => { /* persistence is best-effort */ }); };
    // The chat shows task progress as ACTIONS (transitions), not a kanban board. One note per real column move.
    board.onMove = (card, _from, to, actor) => emit({ kind: "note", text: moveNote(card, to, actor) });

    emit({ kind: "phase", phase: "waves" });
    const wave = await runWaves(deps, session, board, { base: opts.fromBranch, prTitle: opts.prTitle });
    emit({ kind: "phase", phase: "waves-done", detail: wave.status });

    let revision: RevisionResult | undefined;
    let deferredAll: string[] = [];
    /**
     * The merged result is reviewed whether or not every task landed.
     *
     * This used to run only on a fully clean run, which meant a job that finished twenty-one of thirty tasks
     * — a real, working, sizeable diff — got no review of the merged result at all, and its deferred
     * findings were never adjudicated. A partial run is not a failed run: what it did produce deserves the
     * same scrutiny as what a clean one produces, and it is what the user will actually be given.
     *
     * Nothing to review is the one case that skips it: a run where every task failed has no diff.
     */
    const reviewable = board.list().some((c) => c.column === "MERGED");
    if (reviewable) {
      emit({ kind: "phase", phase: "pr", detail: wave.pr?.url ?? wave.delivery.branch });
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
      /**
       * The revision pass may fail; the DELIVERY must still happen.
       *
       * A real run spent 162 minutes, merged 71 tasks, and then threw here on a bookkeeping row — and the
       * whole job ended with the work sitting on a branch and no report saying where. Whatever this pass is
       * worth, it is worth less than telling the user what was built and where it is.
       */
      try {
        revision = await runRevision(
          deps, session, board,
          (c) => deps.prAdapter.postComments(c),
          opts.askUser, opts.revisionRounds ?? 3, prDiff, deferred,
        );
        emit({ kind: "phase", phase: "revision-done", detail: revision.status });
      } catch (e) {
        if (deps.signal.aborted) throw e; // a real cancel still ends the job
        emit({ kind: "note", text:
          `⚠️ The PR revision pass could not run (${e instanceof Error ? e.message : String(e)}). ` +
          `The merged work is unaffected — it is delivered below, and the deferred notes are in review-notes.md.` });
      }
    }

    /**
     * Delivery — after the review, so the user's branch contains the review's own fixes.
     *
     * Runs for a partial job too. A run that produced twenty-one working tasks and delivered nothing is
     * indistinguishable, from the outside, from one that built nothing; the user paid for that work and has
     * to be able to run it. What did not get done is reported alongside, so "delivered" is never mistaken
     * for "finished".
     *
     * A pull request, when there is a remote, is already the delivery — the user reviews and merges it
     * themselves, and merging here as well would take that decision away from them.
     */
    if (!wave.pr && reviewable) {
      const landed = await deps.manager.deliverLocally(session, opts.fromBranch);
      if (landed.ok) {
        wave.delivery.mergedInto = opts.fromBranch;
        emit({ kind: "note", text: `📦 Merged into \`${opts.fromBranch}\` — the files are in your working copy.` });
      } else {
        wave.delivery.notMerged = landed.why;
        emit({ kind: "note", text: `📦 Not merged (${landed.why}) — the work is on \`${wave.delivery.branch}\`.` });
      }
    }

    await curate(deps, up.refinedPrompt ?? opts.prompt, board.list(), deferredAll, session.baseWorktree);

    emit({ kind: "phase", phase: "report" });
    const report = await runCoachReport(deps, session, board);
    /**
     * Resume state is kept whenever anything is left undone.
     *
     * This deletion used to be unconditional, under a comment claiming the whole job had succeeded. It also
     * ran on a partial one — so a run that finished twenty-one of thirty tasks deleted the only record of
     * WHICH nine were left, and the remaining work became unreachable. "Resume" then had nothing to resume
     * and would have started the whole job again from the beginning.
     */
    // Every mutation above saved fire-and-forget; settle them before reading the board's fate off disk.
    await flushBoard(boardPath);
    const unfinished = board.list().filter((c) => c.column !== "MERGED");
    if (!unfinished.length) {
      clearCheckpoint(session.root); // nothing left — the state is what makes a resume possible, not clutter
      await rm(join(session.root, "board.json"), { force: true }).catch(() => { /* best-effort */ });
    } else {
      emit({ kind: "note", text:
        `⏸ ${unfinished.length} task(s) were not finished. The board is kept — say **continue** to pick them ` +
        `up without redoing the ${board.list().length - unfinished.length} that are done.` });
    }
    emit({ kind: "phase", phase: "done" });
    /**
     * Recorded as BRANCH work, which is a statement about what undo may not do.
     *
     * A pipeline run never overwrote anything in the user's working tree — it built on a branch. So there is
     * nothing to restore, and dropping someone's branch because a sentence was read as "undo" is not a
     * favour. Saying that plainly is better than a silent refusal, and far better than a guess.
     */
    await recordTurn(process.cwd(), {
      prompt: up.refinedPrompt, kind: "branch", files: [], unsnapshotted: [],
      branch: wave.delivery.branch,
    }).catch(() => { /* bookkeeping must not fail a delivered run */ });
    return { kind: "done", wave, revision, report, session, refinedPrompt: up.refinedPrompt };
  } catch (e) {
    // Keep the worktree on error so the user can inspect whatever the pipeline produced before it failed
    // (files are already committed per-write). Don't closeSession — that would delete them.
    if (session) emit({ kind: "note", text: `📄 Work so far is kept at \`${session.baseWorktree}\` (branch \`${session.baseBranch}\`). Re-run the same request to resume from where it stopped.` });
    // Curate on the way out too: the runs that FAIL are the most instructive ones, and their proposals live
    // only in process memory — rethrowing without curating would throw away exactly the hardest-won signal.
    if (session) await curate(deps, opts.prompt, [], [], session.baseWorktree);
    throw e;
  } finally {
    /**
     * Back to the project, whichever way the run ended.
     *
     * A store still pointed at a finished session would write the next chat turn's memory into a worktree
     * that is closed, or gone — and the failure would be silent, because writing to a path nobody reads
     * looks exactly like writing.
     */
    deps.onSession?.(undefined);
  }
}
