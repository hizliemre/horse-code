import { z } from "zod";
import type { Board } from "../board/board.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { AskUser } from "./review.js";
import { REVIEW_MARKER } from "../adapters/pr.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry } from "./reviewer.js";
import { contextTools } from "./task-types.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import { changedByMerge, refreshAfterChange } from "./trace-refresh.js";

export interface RevisionDeps extends TaskCycleDeps {
  manager: Pick<WorktreeManager, "commitMerge" | "push">;
  /** Injectable git runner (tests); defaults to the real one. Used to detect a revision that changed nothing. */
  git?: GitRunner;
}
/** The outcome travels with the comments: an approval must be sayable, and it has no comments to carry it. */
export type PostComments = (comments: string[], outcome?: "changes" | "approved") => Promise<string | undefined>;

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
  decision: z.enum(["approve", "request-changes"]).describe(
    "`request-changes` only for what must change before merge; each comment is then applied by another "
    + "agent and answered on the pull request. `approve` when nothing left would block the merge."),
  comments: z.array(z.string()),
});
export const PrincipalFinalSchema = z.object({
  decision: z.enum(["accept", "ask-human"]).describe(
    "The rounds are over and findings remain. `accept`: they can merge as they stand. `ask-human`: only a "
    + "person can settle it — this stops the run, so use it when the remaining finding is a real decision, "
    + "not when it is merely unfinished."),
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
    // The principal decides what ships; what it learns about this codebase outlives the round.
    tools: readOnlyRegistry(deps, { remember: true }),
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

/**
 * What the reviser did, and whether it finished.
 *
 * `said` is its own account of each comment — fixed it, or why the comment is wrong. That prose used to go to
 * the terminal and nowhere else, so the pull request carried the objections and never the answers.
 */
export interface RevisionAccount { ok: boolean; said: string }

/** How much of the reviser's account goes on the pull request. A thread is read; a transcript is not. */
export const MAX_REPLY_CHARS = 6_000;

/**
 * The answer that goes back into the review thread.
 *
 * It names the commit, because that is what a reader checks, and carries the reviser's own words about each
 * comment. When the reviser ran out of turns mid-round the reply says so — a thread resolved as though the
 * work were complete, when the next round is what finishes it, is worse than one left open.
 */
/**
 * How the revision ended, said ON the pull request.
 *
 * Only the approving exit ever spoke. The other two — rounds exhausted and accepted, or a question put to
 * the user — returned in silence, so a reader saw the last round's objections standing with nothing after
 * them and no way to know the run had finished at all. Measured on PR #777: five review threads, the newest
 * fifty minutes before the run ended, and not one word about how it concluded.
 */
async function sayHowItEnded(
  deps: RevisionDeps,
  postComments: PostComments,
  how: "accepted" | "human",
  round: number,
  question?: string,
): Promise<void> {
  const said = how === "accepted"
    ? `The revision rounds are over after round ${round}. The remaining findings above were judged acceptable `
      + `to merge as they stand — they were not silently dropped, and nothing further will be applied `
      + `automatically.`
    : `The revision rounds are over after round ${round} and this needs a decision that is not mine to make. `
      + `The question put to the user was:\n\n> ${question ?? "(not recorded)"}`;
  try { await postComments([said], "changes"); }
  catch (e) { deps.note?.(`⚠️ Could not post how the revision ended (${e instanceof Error ? e.message : String(e)}).`); }
}

export function revisionReplyBody(round: number, account: RevisionAccount, commit: string): string {
  const head = `${REVIEW_MARKER} — round ${round} applied in \`${commit}\`.`;
  const rest = account.ok
    ? ""
    : `\n\n_The reviser reached its turn budget on this round; what it changed is in the commit above and the `
      + `next review round picks up the remainder._`;
  const said = account.said.length > MAX_REPLY_CHARS
    ? `${account.said.slice(0, MAX_REPLY_CHARS)}…`
    : account.said;
  return said
    ? `${head}\n\n${said}${rest}`
    : `${head}\n\n_The reviser left no written account of the round; the commit is the record._${rest}`;
}

async function seniorRevise(deps: RevisionDeps, base: string, comments: string[]): Promise<RevisionAccount> {
  const resolved = deps.roleRegistry.resolve("senior-coder");
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  /**
   * The reviser writes the LAST code to enter the pull request, and it was the worst-equipped agent in the run.
   *
   * `principalReview` reads through `readOnlyRegistry`, which carries git, the code graph and the project's
   * read-only MCP tools. The reviser had none of them — the default registry and a skill tool — so it could
   * not ask what calls the function it was about to change, and every git question it had went through shell.
   */
  for (const t of contextTools(deps)) tools.register(t);
  const hints = memoryHints(deps, comments.join(" "), { role: "senior-coder" });
  /**
   * "the main worktree" pointed AWAY from where the agent already was.
   *
   * The reviser runs in the session's base checkout, and that phrase reads as the project's own — which is
   * exactly where it went: `git worktree list`, `cd /Users/…/parrot && git status`, `find . -name
   * "*safe-html-pr-revision*"`. Naming nothing is better than naming the wrong thing; the working directory
   * is now stated once, for every role, by the agent loop.
   */
  const ask = { role: "user" as const, content: `PR revision: address the following comments — fix each one, or `
    + `say plainly which is wrong and why. Start by editing; you have already been given what to change:\n`
    + `${comments.map((c) => `- ${c}`).join("\n")}` };
  const spoken: string[] = [];
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved, tools,
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
    maxTurns: reviseTurnBudget(comments.length),
    // The last code to enter the pull request: what the reviser says about each comment — fixed it, or why
    // it is by design — is the argument the user is being asked to accept. Kept, not just shown: it is what
    // gets posted back into the review thread.
    onSay: (t: string) => { spoken.push(t); deps.note?.(t); },
  };
  try {
    await runToCompletion(opts);
    return { ok: true, said: spoken.join("\n\n").trim() };
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
      return { ok: false, said: spoken.join("\n\n").trim() };   // …and that next round has to exist — see `extra` in runRevision.
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
  /**
   * Answers ONE review thread with what was done about it, and resolves it.
   *
   * Without this a run left its objections on the pull request and never its answers: measured on PR #777,
   * five stacked "N change(s) requested" threads, all Active, nothing anywhere saying which findings had
   * been fixed. The reader could see what horse-code asked for and never what it did.
   */
  replyAndResolve?: (threadId: string, body: string) => Promise<void>,
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
  /**
   * A round the reviser could not finish must not cost a round.
   *
   * When the turn budget runs out mid-round, the code says so out loud — "what it changed is kept; the next
   * review round reads the result and asks for the rest" — and that promise is only true if a revising round
   * is still left. The LAST round never revises: it asks the principal for a final verdict and, failing
   * that, asks the user. Reported live: nine comments exhausted a 72-turn budget in round 1, and the run
   * then spent its remaining rounds and put the unfinished findings to the user as a question.
   *
   * Bounded by the same number as the budget itself, so a reviser that never converges still ends.
   */
  let extra = 0;
  const cap = rounds * 2;

  for (let round = 1; round <= rounds + extra; round++) {
    /**
     * Said out loud, because this is the longest silent stretch in a run.
     *
     * The phase marker fires once, before the first round, and then a principal review and a senior rewrite
     * happen per round with nothing on screen. Reported after a 577-minute run: "revizyon turunun surdugune
     * dair ekranda geri bildirim yok" — and the person watching had no way to tell it from a hang.
     */
    deps.note?.(`🔁 PR revision, round ${round}/${rounds + extra} — the principal reviewer is reading the merged diff.`);
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

    if (round === rounds + extra) {
      const f = await principalFinal(deps, base);
      if (f.decision === "accept") {
        board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:final:accept" });
        await sayHowItEnded(deps, postComments, "accepted", round);
        return { status: "accepted", rounds };
      }
      const answer = await askUser(f.question);
      board.appendStage(REVISION_CARD, { role: "human", action: "pr:human", note: answer });
      await sayHowItEnded(deps, postComments, "human", round, f.question);
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
    let threadId: string | undefined;
    try { threadId = await postComments(v.comments); }
    catch (e) { deps.note?.(`⚠️ Could not post the review comments to the pull request (${e instanceof Error ? e.message : String(e)}) — applying them anyway.`); }
    const beforeRevise = await worktreeState(deps, base);
    // A round cut short by the turn budget buys one more, up to `cap` — see `extra`.
    const account = await seniorRevise(deps, base, v.comments);
    if (!account.ok && rounds + extra < cap) extra++;
    // A revision that changed nothing means the next principal review would see IDENTICAL code and repeat the
    // same comments — burning every remaining round. Retry once with an explicit instruction, then stop.
    if (beforeRevise !== undefined && (await worktreeState(deps, base)) === beforeRevise) {
      board.appendStage(REVISION_CARD, { role: "senior-coder", action: "pr:no-changes" });
      const retry = await seniorRevise(deps, base, [...v.comments, "Your previous attempt changed NO files. Apply the fixes with write_file/edit_file, or state clearly which comment is wrong and why."]);
      account.said = [account.said, retry.said].filter(Boolean).join("\n\n");
      if ((await worktreeState(deps, base)) === beforeRevise) {
        const f = await principalFinal(deps, base); // nothing is moving → settle it now instead of looping
        if (f.decision === "accept") {
          board.appendStage(REVISION_CARD, { role: "principal-coder", action: "pr:final:accept" });
          await sayHowItEnded(deps, postComments, "accepted", round);
          return { status: "accepted", rounds: round };
        }
        const answer = await askUser(f.question);
        board.appendStage(REVISION_CARD, { role: "human", action: "pr:human", note: answer });
        await sayHowItEnded(deps, postComments, "human", round, f.question);
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
    /**
     * …and the thread that asked for all this is answered, then resolved.
     *
     * AFTER the push, so the reply cannot point at commits the reader has no way to see yet. The account is
     * the reviser's own prose; when it produced none, the thread still gets the commit it was answered by
     * rather than being closed in silence.
     */
    if (threadId && replyAndResolve) {
      const body = revisionReplyBody(round, account, `hc: revision ${round}`);
      try { await replyAndResolve(threadId, body); }
      catch (e) { deps.note?.(`⚠️ Could not answer the review thread (${e instanceof Error ? e.message : String(e)}).`); }
    }
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
  const files = await changedByMerge(gitOf(deps), base, headBefore);
  await refreshAfterChange({
    cwd: base, files, provider: deps.provider, models: deps.roleRegistry.chainFor("tracer", 0),
    signal: deps.signal, git: gitOf(deps), ...(deps.note ? { note: (t: string) => deps.note?.(t) } : {}),
  });
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
