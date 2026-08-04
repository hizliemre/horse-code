import { z } from "zod";
import type { Board } from "../board/board.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { AskUser } from "./review.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry } from "./reviewer.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import { changedByMerge, refreshTraces, describeRefresh, commitRefreshed } from "./trace-refresh.js";

export interface RevisionDeps extends TaskCycleDeps {
  manager: Pick<WorktreeManager, "commitMerge" | "push">;
  /** Injectable git runner (tests); defaults to the real one. Used to detect a revision that changed nothing. */
  git?: GitRunner;
}
/** The outcome travels with the comments: an approval must be sayable, and it has no comments to carry it. */
export type PostComments = (comments: string[], outcome?: "changes" | "approved") => Promise<void>;

/**
 * The board row that records the PR revision rounds. It is BOOKKEEPING, not work.
 *
 * Named here and exported because two other places have to know it is not a task. A wave engine that
 * schedules it hands "PR revision" to a coder, which writes straight into the base worktree while tasks are
 * still merging into it — measured on a real run: the card was reopened on resume, picked up as a task, and
 * the base was left mid-merge, so the next task's merge died with "You have not concluded your merge
 * (MERGE_HEAD exists)" and took the run down with it.
 */
export const REVISION_CARD = "__revision__";

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

/** HEAD + dirty state of the base worktree — detects a revision pass that produced no change at all. */
async function worktreeState(deps: RevisionDeps, base: string): Promise<string | undefined> {
  const git = deps.git ?? defaultGitRunner;
  const head = await git(["rev-parse", "HEAD"], base);
  if (head.code !== 0) return undefined; // not a git worktree (tests/stubs) → guard disabled
  const status = await git(["status", "--porcelain"], base);
  return `${head.stdout.trim()}|${status.stdout.trim()}`;
}

async function principalReview(deps: RevisionDeps, base: string, prDiff?: string, deferred?: string[]) {
  const resolved = deps.roleRegistry.resolve("principal-coder");
  // Findings the per-task code review deliberately did not block on. A task that passed has no further attempt,
  // so THIS is where they get adjudicated — once, on the merged result. The principal decides which are worth
  // fixing now; the rest are consciously accepted (they stay recorded in review-notes.md either way).
  const carried = deferred?.length
    ? `\n\nThe per-task code review deferred these non-blocking findings — judge which genuinely deserve a fix ` +
      `now and include those in your comments; ignore the ones that are not worth it:\n${deferred.map((d) => `- ${d}`).join("\n")}`
    : "";
  const content = (prDiff
    ? `PR review: review the following diff:\n${prDiff}\n(use the read tools to inspect the worktree if needed.) Give approve or request-changes + concrete comments.`
    : "PR review: review all changes in the base worktree holistically. Give approve or request-changes + concrete comments.") + carried;
  const hints = memoryHints(deps, content, { role: "principal-coder" });
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps, { propose: true }),
    proposeMemory: (t, k) => deps.proposeMemory?.(t, k, "principal-coder") ?? false,
    messages: hints.message ? [{ role: "user", content: hints.message }, { role: "user", content }] : [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  const review = await runStructuredRole(opts, PrincipalReviewSchema);
  reinforceUsed(deps, hints.ids, review.comments.join(" "), "principal-coder");
  return review;
}

async function principalFinal(deps: RevisionDeps, base: string) {
  const resolved = deps.roleRegistry.resolve("principal-coder");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: "FINAL DECISION: Revision rounds are over and findings still remain. Give accept or ask-human (a question to ask the user)." }],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
  };
  return runStructuredRole(opts, PrincipalFinalSchema);
}

/**
 * Turns per review comment, and a floor.
 *
 * The revision ran on the default 50 — a number that knows nothing about the work. Measured on a real PR of
 * seventeen commits: `maximum turn count exceeded (50)`, the pass abandoned, and the card left carrying
 * `pr:changes` while the merged work shipped unreviewed. This is the third fixed ceiling to fail the same
 * way: five minutes for a graph build, twelve turns for a conflict, fifty here. A budget that ignores the
 * size of the job is a guess, and the guess is wrong exactly when the job is big.
 *
 * Each comment is read, located, fixed and verified, which is several turns; the floor covers the case where
 * a single comment turns out to be the hard one.
 */
export const REVISE_TURNS_PER_COMMENT = 8;
export const REVISE_TURNS_MIN = 30;
export const REVISE_TURNS_MAX = 200;

/** Same rule the structured-role runner uses: a spent budget means "still working", not "broken". */
const TURN_LIMIT_RE = /maximum turn count exceeded/i;

export function reviseTurnBudget(commentCount: number): number {
  return Math.min(REVISE_TURNS_MAX, Math.max(REVISE_TURNS_MIN, commentCount * REVISE_TURNS_PER_COMMENT));
}

async function seniorRevise(deps: RevisionDeps, base: string, comments: string[]): Promise<void> {
  const resolved = deps.roleRegistry.resolve("senior-coder");
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const hints = memoryHints(deps, comments.join(" "), { role: "senior-coder" });
  const ask = { role: "user" as const, content: `PR revision: address the following comments (fix them or justify as "by design"), work in the main worktree:\n${comments.map((c) => `- ${c}`).join("\n")}` };
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved, tools,
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
    maxTurns: reviseTurnBudget(comments.length),
    // The last code to enter the pull request: what the reviser says about each comment — fixed it, or why
    // it is by design — is the argument the user is being asked to accept.
    ...(deps.note ? { onSay: deps.note } : {}),
  };
  try {
    await runToCompletion(opts);
  } catch (e) {
    /**
     * A revision that ran out of turns still did work, and saying only "could not run" hides it.
     *
     * The previous message reported the failure and nothing else, so a user could not tell a pass that
     * achieved nothing from one that fixed nine comments out of ten. The commits are already on the branch
     * either way — the per-write auto-commit sees to that — so what is missing is the account of them.
     */
    const why = e instanceof Error ? e.message : String(e);
    /**
     * Running out of turns is not a failure — it is a reviser that was still working.
     *
     * Measured on a 577-minute run. The principal review produced five substantial comments; the reviser
     * spent its whole budget on them — exactly 40 calls against `reviseTurnBudget(5) === 40` — and had
     * already reverted the dependency churn and hardened the length guard when the ceiling hit. Rethrowing
     * threw that away: the round died, `commitMerge` never ran, the pass never reached round 2, no question
     * reached the human, and the run simply ended. The edits were still sitting UNCOMMITTED in the base
     * worktree hours later — while this very message told the user they were "committed on the branch".
     *
     * Returning instead lets the round finish the way it always does: the changes are committed and pushed,
     * and the NEXT principal review reads the improved branch and asks for whatever is still missing. That
     * is what the rounds are for.
     */
    if (TURN_LIMIT_RE.test(why)) {
      deps.note?.(`⚠️ The reviser used its whole turn budget on ${comments.length} comment(s). What it changed `
        + `is kept and committed with this round; the next review round reads the result and asks for the rest.`);
      return;
    }
    deps.note?.(`⚠️ The revision pass stopped: ${why}. It had ${comments.length} comment(s) to address and its `
      + `work up to that point is committed on the branch — re-run to continue from there.`);
    throw e;
  }
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
  deferred?: string[], // non-blocking findings carried over from the per-task code reviews
  resolveThreads?: () => Promise<void>, // closes the threads this review opened, once it approves
): Promise<RevisionResult> {
  /**
   * The revision pass keeps its own card, and a RESUMED board already has it.
   *
   * `addCard` throws on a duplicate id, and the board is persisted across runs — so the second run of any
   * job died here, at the very end, after all the work was done: "card already exists: revision". Measured
   * on a real run: 162 minutes, 71 tasks merged, 22 deferred notes ready to adjudicate, and the delivery
   * never happened because of a bookkeeping row.
   *
   * Reusing it is also the right behaviour, not just the safe one: the card's history is the record of the
   * earlier revision rounds, and a resumed run continues them.
   */
  if (!board.get(REVISION_CARD)) board.addCard({ id: REVISION_CARD, title: "PR revision" });
  const base = session.baseWorktree;
  const rounds = Math.max(1, maxRounds);

  for (let round = 1; round <= rounds; round++) {
    /**
     * Said out loud, because this is the longest silent stretch in a run.
     *
     * The phase marker fires once, before the first round, and then a principal review and a senior rewrite
     * happen per round with nothing on screen. Reported after a 577-minute run: "revizyon turunun surdugune
     * dair ekranda geri bildirim yok" — and the person watching had no way to tell it from a hang.
     */
    deps.note?.(`🔁 PR revision, round ${round}/${rounds} — the principal reviewer is reading the merged diff.`);
    const v = await principalReview(deps, base, prDiff, round === 1 ? deferred : undefined);
    if (v.decision === "approve") {
      board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:approved" });
      deps.note?.(`✅ PR revision: the merged diff was reviewed and approved.`);
      /**
       * Said on the pull request, and the objections it raised earlier are closed with it.
       *
       * Silence is what a review that never ran looks like, and an approval left beside its own still-open
       * threads leaves the reader to work out which of them still stand. Measured on PR #765: two `Active`
       * threads, every finding of the first one demonstrably fixed on the branch, and the review approved.
       */
      try { await postComments(v.comments, "approved"); }
      catch (e) { deps.note?.(`⚠️ Could not post the approval to the pull request (${e instanceof Error ? e.message : String(e)}).`); }
      try { await resolveThreads?.(); }
      catch (e) { deps.note?.(`⚠️ Could not resolve the review threads (${e instanceof Error ? e.message : String(e)}).`); }
      return { status: "approved", rounds: round - 1 };
    }
    board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:changes", note: v.comments.join("; ") });

    if (round === rounds) {
      const f = await principalFinal(deps, base);
      if (f.decision === "accept") {
        board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:final:accept" });
        return { status: "accepted", rounds };
      }
      const answer = await askUser(f.question);
      board.appendStage(REVISION_CARD, { role: "human", action: "pr:human", note: answer });
      return { status: "human", rounds, answer };
    }

    deps.note?.(`🔁 Round ${round}: ${v.comments.length} change(s) requested — applying them.`);
    /**
     * Posting to the pull request is a courtesy; the revision is the work.
     *
     * A throw here used to end the whole pass — and the board showed exactly that: one `pr:changes` entry and
     * nothing after it, on a run whose 27 tasks had all merged. The comments are already recorded in the
     * card's history and in review-notes.md, so failing to mirror them onto the platform is worth a line, not
     * the loss of the round they belong to.
     */
    try { await postComments(v.comments); }
    catch (e) { deps.note?.(`⚠️ Could not post the review comments to the pull request (${e instanceof Error ? e.message : String(e)}) — applying them anyway.`); }
    const beforeRevise = await worktreeState(deps, base);
    await seniorRevise(deps, base, v.comments);
    // A revision that changed nothing means the next principal review would see IDENTICAL code and repeat the
    // same comments — burning every remaining round. Retry once with an explicit instruction, then stop.
    if (beforeRevise !== undefined && (await worktreeState(deps, base)) === beforeRevise) {
      board.appendStage(REVISION_CARD, { role: "senior-coder", action: "pr:no-changes" });
      await seniorRevise(deps, base, [...v.comments, "Your previous attempt changed NO files. Apply the fixes with write_file/edit_file, or state clearly which comment is wrong and why."]);
      if ((await worktreeState(deps, base)) === beforeRevise) {
        const f = await principalFinal(deps, base); // nothing is moving → settle it now instead of looping
        if (f.decision === "accept") {
          board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:final:accept" });
          return { status: "accepted", rounds: round };
        }
        const answer = await askUser(f.question);
        board.appendStage(REVISION_CARD, { role: "human", action: "pr:human", note: answer });
        return { status: "human", rounds: round, answer };
      }
    }
    board.appendStage(REVISION_CARD, { role: "senior-coder", action: "pr:revised" });
    deps.note?.(`🔁 Round ${round}: revised and committed.`);
    /**
     * A revision round writes straight into the base worktree, so it never passes the merge that refreshes
     * traces — and this is the LAST code to enter the pull request. Left alone, the files a reviewer just had
     * rewritten would ship described as they were before the review.
     */
    const headBefore = (await gitOf(deps)(["rev-parse", "HEAD"], base)).stdout.trim();
    await deps.manager.commitMerge(session, `hc: revision ${round}`);
    await refreshAfterRevision(deps, base, headBefore);
    await deps.manager.push(session);
  }
  // unreachable (rounds ≥ 1 → the last iteration always returns); for type safety:
  return { status: "accepted", rounds };
}


const gitOf = (deps: RevisionDeps): GitRunner => deps.git ?? defaultGitRunner;

/**
 * Re-describes what a revision round changed, in the base worktree that is about to be pushed.
 *
 * Best-effort, exactly as after a merge: the revision is already committed, and a tracer that cannot run is
 * not a reason to fail a pull request. The read path marks whatever stays stale.
 */
async function refreshAfterRevision(deps: RevisionDeps, base: string, headBefore: string): Promise<void> {
  try {
    const files = await changedByMerge(gitOf(deps), base, headBefore);
    if (!files.length) return;
    const r = await refreshTraces({
      cwd: base,
      files,
      provider: deps.provider,
      models: deps.roleRegistry.chainFor("tracer", 0),
      signal: deps.signal,
      note: (t) => deps.note?.(t),
    });
    const line = describeRefresh(r);
    if (line) deps.note?.(line);
    // Committed here too, for the same reason: a loose trace in the base breaks whatever merges next.
    /**
     * Unconditional, because the condition was wrong.
     *
     * A refresh rebuilds the graph BEFORE deciding whether any trace needs rewriting, so the commonest
     * outcome — nothing to re-describe — still leaves `graphify-out/graph.json` modified. Gating the commit
     * on "did we write a trace" left that file loose on exactly the merges where nothing else happened,
     * which is the same failure one step along. `commitRefreshed` asks git whether anything is staged, so
     * calling it when nothing changed costs one command and commits nothing.
     */
    const { traceRootRel } = await import("./trace.js");
    await commitRefreshed(gitOf(deps), base, traceRootRel());
  } catch { /* never the reason a revised pull request is reported as failed */ }
}

/**
 * Closes the revision row, whatever became of the pass.
 *
 * Nothing did. The pass writes its rounds into the card's HISTORY and never touches its column, so a finished
 * run reported "1 task(s) were not finished. The board is kept — say continue to pick them up" about a row
 * that was never work. Measured at the end of a 577-minute run with all 27 real tasks merged and the pull
 * request open.
 *
 * Telling someone to continue work that is done is worse than saying nothing, because continuing is exactly
 * what would re-open it.
 *
 * Closed on FAILURE too, and that is the case the report was misreading: a revision that could not run is a
 * revision that will not run by being asked again from the board.
 */
export function closeRevision(board: Board, result?: RevisionResult, failure?: string): void {
  if (!board.get(REVISION_CARD)) return;
  /**
   * Only a FAILURE needs recording here: every path that returns has already written its own outcome —
   * `pr:approved`, `pr:final:accept`, `pr:human`. Writing it again produced two identical `pr:approved`
   * entries in a row on the first run this closed, which reads as two reviews rather than one.
   */
  if (failure) board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:failed", note: failure });
  board.move(REVISION_CARD, "DONE", "principal-coder");
}
