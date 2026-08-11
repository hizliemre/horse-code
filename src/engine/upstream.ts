import { execFileSync } from "node:child_process";
import { inLinkedWorktree, sessionBase } from "./session-scope.js";
import { existsSync } from "node:fs";
import { relative, dirname } from "node:path";
import type { Message } from "../core/types.js";
import type { ReviewDeps, AskUser } from "./review.js";
import { runRefiner, routeIntent, type Intent } from "./refiner.js";
import { lastTurn, undoTurn, clearTurn, describeUndo, describeForContext, snapshot, recordTurn } from "./turn-effect.js";
import { runCoachChat } from "./coach.js";
import { extractListBlock } from "./next-steps.js";
import { runReviewLoop } from "./review.js";
import { commitStep } from "./operational.js";
import { askInUserLanguage } from "./user-language.js";
import { isContinuePrompt, readCheckpoint, writeCheckpoint, type UpstreamPhase, type Checkpoint } from "./checkpoint.js";
import { appendReviewNotes } from "./review-notes.js";
import type { ProgressEvent } from "./progress.js";
import { constitutionPath, nextFeatureSlug, scaffoldFeature } from "../speckit/layout.js";
import type { PhaseDeps } from "../speckit/phases.js";
import { runBrainstorm, runConstitution, runSpecify, runPlan, runTasks } from "../speckit/phases.js";
import { runClarify } from "../speckit/clarify.js";

export { buildAskUserTool } from "./writer-registry.js";

export type UpstreamResult =
  | { intent: Intent; refinedPrompt: string; kind: "chat"; response: string; nextSteps: string[]; rules: string[]; remembered: string[]; lessons: string[] }
  | { intent: Intent; refinedPrompt: string; kind: "approved"; specPath: string; planPath: string; tasksPath: string }
  | { intent: Intent; refinedPrompt: string; kind: "rejected"; stage: "spec" | "plan" }
  | { intent: Intent; refinedPrompt: string; kind: "governed"; path: string; written: boolean }
  | { intent: Intent; refinedPrompt: string; kind: "undone"; report: string }
  | { intent: Intent; refinedPrompt: string; kind: "verified"; report: string; reportPath: string; written: boolean }
  | { intent: Intent; refinedPrompt: string; kind: "tweaked"; report: string; done: boolean };

/**
 * Upstream pipeline: refiner → route; chat→coach response; feature/bugfix→spec-kit phases
 * (constitution → brainstorm → specify → clarify → plan → tasks) with the council/judge review loop after
 * spec AND plan. The brainstorm decides the APPROACH with the user; everything after it runs autonomously.
 * On approval returns {specPath, planPath, tasksPath}; if rejected, {rejected, stage}.
 */
/**
 * A run works in a worktree, unless it is already standing in one.
 *
 * `verify` and `govern` produce documents rather than code, so they used to run wherever the user was —
 * which meant the project checkout. Measured after one verify: `specs/004-product-upload-testing/`
 * untracked in the repository root, beside two shared files a start-up pass had modified. The rule is the
 * same as for code: what a run produces belongs on a branch, not in the reference copy.
 *
 * Already inside a linked worktree is the exception, and the important one. A worktree cut from a worktree
 * is a checkout nobody asked for nested inside one someone did — so a run that starts there stays there.
 * Saying so explicitly still branches: the phrase is the only thing that can distinguish "I am working in
 * this worktree" from "give this its own".
 */
const WANTS_WORKTREE = /\bworktree\b/i;

function gitSync(cwd: string): (args: string[]) => string | undefined {
  return (args) => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return undefined; }
  };
}

async function documentWorkdir(
  cwd: string, prompt: string, ensureWorktree: (nameHint?: string) => Promise<string>, nameHint?: string,
): Promise<string> {
  if (inLinkedWorktree(cwd, gitSync(cwd)) && !WANTS_WORKTREE.test(prompt)) return cwd;
  return ensureWorktree(nameHint);
}

/**
 * Leaves a resumable marker for a lane that never reaches the pipeline.
 *
 * `verify` and `govern` open a worktree and return long before `writeCheckpoint` is called, so a run stopped
 * halfway had nothing to come back to: "devam" answered "no resumable worktree with a checkpoint was found
 * in this project" while the worktree stood there holding the work. Nothing is written when the lane worked
 * in place — there is no session to reopen, and a checkpoint in the project root would claim otherwise.
 */
function laneCheckpoint(
  cwd: string, lane: "verify" | "govern", resume: Checkpoint | undefined, prompt: string,
  r: { refinedPrompt: string; title: string; language: string; intent: Intent },
): void {
  const root = sessionBase(cwd);
  if (root === undefined) return;
  writeCheckpoint(dirname(root), {
    rawPrompt: resume?.rawPrompt ?? prompt,
    refinedPrompt: r.refinedPrompt, title: r.title, language: r.language,
    featureSlug: resume?.featureSlug ?? "", done: [], lane, intent: r.intent,
  });
}

/**
 * Which lane a request belongs to, when a session already holds a checkpoint.
 *
 * The guard used to be `!resume || resume.lane === "…"`, and that was wrong in the case it was written for.
 * A session now spans several requests, so a checkpoint is almost always present — and one written by the
 * pipeline carries no lane. Reported live: "continue the smoke tests" was refined into a verify request, the
 * session's checkpoint said `done: ["constitution"]` with no lane, the whole verify branch was skipped, and
 * the run started BRAINSTORMING a feature nobody had asked for.
 *
 * The INTENT decides. The checkpoint only answers for a bare "devam", which says nothing about what to do
 * and everything about wanting the last thing continued.
 */
function laneFor(r: { intent: Intent }, prompt: string, resume: Checkpoint | undefined): string {
  const intent = routeIntent(r.intent);
  if (intent !== "chat") return intent;
  return isContinuePrompt(prompt) && resume?.lane ? resume.lane : intent;
}

export async function runUpstream(
  deps: ReviewDeps,
  ensureWorktree: (nameHint?: string) => Promise<string>,
  prompt: string,
  askUser: AskUser,
  maxRounds: number,
  history: Message[] = [],
  emit: (ev: ProgressEvent) => void = () => {},
  images?: string[], // pasted images → attached to the coach's chat turn (vision)
  resume?: Checkpoint, // set when resuming preserved work: skip the refiner, drive the pipeline from the checkpoint
  /**
   * Whether unfinished work for this project is waiting.
   *
   * Sizing has to happen BEFORE a worktree exists, and the checkpoint that says "this is half-built" lives
   * inside one. So the caller, which can see whether anything is preserved, says so — otherwise a feature
   * abandoned mid-plan could be re-sized as a small change and quietly finished by one implementer.
   */
  hasPreservedWork = false,
  /**
   * Where this sitting is already working, asked for only when it matters.
   *
   * The small-change path does its work in `process.cwd()` — right when there is nowhere else, and wrong the
   * moment a session is open: the developer picked a worktree for this work and the change belongs in it,
   * small or not. Measured live: a one-line fix went into the team's shared branch while the worktree it
   * belonged to sat open beside it.
   *
   * A function, not a path: calling it ADOPTS the session (memory store, session handle, one note), and a
   * chat turn must go on adopting nothing.
   */
  workingIn?: () => string | undefined,
): Promise<UpstreamResult> {
  // Each spec-kit phase is driven by a specific role — surface it (+ its model) in the status detail so the
  // user sees WHO is working (e.g. "Writing spec… — analyst · cc/opus-4-8"), not just the persistent coach badge.
  const PHASE_ROLE: Record<string, string> = { constitution: "analyst", brainstorm: "brainstormer", specify: "analyst", clarify: "analyst", plan: "planner", tasks: "project-manager" };
  const emitPhase = (phase: string): void => {
    const role = PHASE_ROLE[phase];
    const model = role ? deps.roleRegistry.peekModel(role) : "";
    emit({ kind: "phase", phase, detail: role ? `${role} · ${model}` : undefined });
  };
  // Resume: a "continue" request reuses the checkpoint's refined prompt/title/language directly — no refiner
  // pass, no re-classification. Otherwise the refiner sees the history → follow-ups are refined in context.
  // Refiner + chat run WITHOUT a worktree (read-only / classify); the worktree is opened lazily below,
  // only for the feature/bugfix pipeline — so a plain chat never creates a worktree.
  /**
   * What the last turn DID, in front of the classifier and the coach.
   *
   * Only the transcript's text crossed the turn boundary, so "undo your changes" arrived with nothing for
   * "your changes" to point at — and a request about work already done was read as a request for more of it.
   * One sentence naming the files closes that, and it is the same sentence that lets the coach answer "what
   * did you change?" at all.
   */
  const priorContext = describeForContext(await lastTurn(process.cwd()));
  const withPrior: Message[] = priorContext
    ? [{ role: "assistant", content: priorContext }, ...history]
    : history;
  /**
   * A resumed run keeps what it WAS, instead of being told it is a feature.
   *
   * The checkpoint carries everything a resume needs so the refiner can be skipped — and it used to carry
   * everything except the field that decides what happens next. So every continued session was a `feature`:
   * a verification resumed with "devam" answered "Writing the feature spec" and went on to produce a
   * constitution and a brainstorm for a request whose whole output was a test report.
   *
   * Checkpoints written before `intent` existed have none; those still read as `feature`, which is what they
   * did before and what they were most likely to be.
   */
  const r = resume
    ? { intent: resume.intent ?? ("feature" as Intent), refinedPrompt: resume.refinedPrompt, title: resume.title, language: resume.language }
    : await runRefiner(deps, prompt, withPrior);
  // Surface the refined prompt as soon as it's ready → the UI can replace the raw prompt before the
  // coach/pipeline runs (the refined prompt is what actually gets handed downstream).
  emit({ kind: "refined", refinedPrompt: r.refinedPrompt });
  if (!resume && routeIntent(r.intent) === "chat") {
    // Refine is done → the coach now works. Emit the phase change here (not after) so the UI shows the
    // coach-waiting status ("zottiring…") while the coach runs, not the refine status.
    emit({ kind: "phase", phase: "chat" });
    // Chat: no worktree — the coach reads the repo in place (cwd ".") + history → a contextual response.
    const raw = await runCoachChat(deps, r.refinedPrompt, ".", withPrior, r.language, images);
    const ns = extractListBlock(raw, "nextsteps"); // suggested follow-ups
    const ru = extractListBlock(ns.text, "rule"); // durable behavioral rules → always-honored memory
    const rm = extractListBlock(ru.text, "remember"); // durable facts to persist to memory
    const ls = extractListBlock(rm.text, "lesson"); // lessons learned from a correction/failure
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "chat", response: ls.text, nextSteps: ns.items, rules: ru.items, remembered: rm.items, lessons: ls.items };
  }

  /**
   * Governance work runs where the user is standing.
   *
   * A constitution is the project's own statement of its principles, and it is finished the moment it is
   * written — there is nothing to review against a spec, nothing to break, nothing to merge. Routing it
   * through the pipeline bought a branch, a worktree cut from it, a spec, a plan, a task board and a wave
   * engine, all to produce one document that then sat in a branch instead of in the project.
   *
   * Deliberately NOT committed: the file lands in the working tree the user is looking at, and what to do
   * with it from there is theirs to decide. A tool that commits to someone's branch unasked is a tool that
   * has to be undone.
   */
  /**
   * Undo runs on git and a snapshot, never on a model.
   *
   * The model's whole job here was deciding that the sentence WAS an undo; what to put back is a question
   * with an exact answer, and a wrong undo is worse than the wrong write it exists to fix.
   */
  if (!resume && routeIntent(r.intent) === "undo") {
    const cwd = process.cwd();
    const effect = await lastTurn(cwd);
    const res = await undoTurn(cwd, effect);
    if (!res.refused) await clearTurn(cwd); // a turn is undone once; a second "undo" must not undo the undo
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "undone", report: describeUndo(res) };
  }

  /** Verify writes a report; a report is work, and work belongs on a branch. See documentWorkdir. */
  if (laneFor(r, prompt, resume) === "verify") {
    emitPhase("verify");
    const cwd = await documentWorkdir(process.cwd(), prompt, ensureWorktree, r.title);
    laneCheckpoint(cwd, "verify", resume, prompt, r);
    const { runVerify, describeVerify, currentBranchOf } = await import("./verify.js");
    const branch = await currentBranchOf(cwd);
    const res = await runVerify({
      deps, workdir: cwd, prompt: r.refinedPrompt, title: r.title, askUser,
      // The refined prompt is English by design; without this the tester answers a Turkish session in English.
      language: r.language,
      note: (text) => emit({ kind: "note", text }),
    });
    return {
      intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "verified",
      report: describeVerify(res, branch, cwd), reportPath: res.reportPath, written: res.reportWritten,
    };
  }

  if (laneFor(r, prompt, resume) === "govern") {
    emitPhase("constitution");
    const templates = await deps.specKit();
    // A constitution is a committed document, so it is written on a branch like anything else.
    const cwd = await documentWorkdir(process.cwd(), prompt, ensureWorktree, r.title);
    laneCheckpoint(cwd, "govern", resume, prompt, r);
    const p: PhaseDeps = { deps, templates, workdir: cwd, askUser, ...(r.language ? { language: r.language } : {}) };
    // Taken BEFORE the phase runs — the only moment the previous version still exists.
    const rel = relative(cwd, constitutionPath(cwd));
    const before = await snapshot(cwd, rel);
    // The request travels with the phase: without it the analyst is asked to establish a constitution the
    // project already has, and has to ask the user what they wanted. See runConstitution.
    await runConstitution(p, r.refinedPrompt);
    const path = constitutionPath(cwd);
    const written = existsSync(path);
    if (written) {
      await recordTurn(cwd, { prompt: r.refinedPrompt, kind: "in-place", files: [before], unsnapshotted: [] });
    }
    if (!written) {
      emit({ kind: "note", text: `⚠️ The constitution phase never wrote \`${relative(cwd, path)}\` — nothing was changed.` });
    }
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "governed", path, written };
  }

  /**
   * Small change → done where the user is standing, before a worktree exists.
   *
   * Measured: "ikonu ortala" classified as a feature and bought the entire pipeline — a worktree, a
   * constitution check, a brainstorm WITH the user, a spec, a plan, a board, waves, a review council and a
   * pull request. To centre an icon.
   *
   * The upstream half of the pipeline exists to work out WHAT to build, and for a request like that there is
   * nothing to work out. The downstream half is kept whole — an implementer writes it, a reviewer reads it,
   * and the acceptance gate checks it — because "small" says the work is obvious, not that it is correct.
   *
   * Sized BEFORE the worktree, because the worktree is most of what makes the pipeline expensive.
   */
  if (!resume && !hasPreservedWork && routeIntent(r.intent) === "pipeline") {
    // Where the work is happening: the open worktree if this sitting has one, else where the user stands.
    const cwd = workingIn?.() ?? process.cwd();
    emitPhase("sizing");
    const { sizeRequest } = await import("./triage.js");
    const size = await sizeRequest(deps, cwd, r.refinedPrompt);
    /**
     * Doubt is put to the user, not resolved by spending.
     *
     * Measured end to end: a request sized `large` produced 507 model calls over 94 minutes for a fix the
     * developer called a simple UI change — bought at the 114th second by one verdict. A wrong `small` costs
     * a review round in front of someone watching; a wrong `large` costs an hour and a half. So the question
     * goes to the person who is already sitting there.
     */
    let small = size.verdict === "small";
    if (size.verdict === "unsure") {
      const { describeSizeDoubt } = await import("./triage.js");
      const answer = await askInUserLanguage(
        deps, askUser, r.language,
        `${describeSizeDoubt(r.refinedPrompt, size.reason)}\n\nWhich is it?`,
        [
          { label: "Small — just do it", description: "Implemented, reviewed and checked against the acceptance criteria, in your working tree." },
          { label: "Full piece of work", description: "Spec, plan, tasks, then waves — on its own branch." },
        ],
      );
      small = /^small/i.test(answer.trim());
    }
    if (small) {
      emitPhase("small change");
      emit({ kind: "note", text: `⚡ Small change — ${size.reason}. No branch, no spec, no plan.` });
      const { runSmallChange, describeSmallChange } = await import("./fix.js");
      const { currentBranchOf } = await import("./verify.js");
      const res = await runSmallChange(deps, cwd, r.title, r.refinedPrompt, size);
      return {
        intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "tweaked",
        report: describeSmallChange(res, size.reason, await currentBranchOf(cwd)), done: res.fixed,
      };
    }
  }

  // Feature/bugfix → open the worktree now; name it from the refiner's short English title (not the raw
  // prompt slug). If this is a resumed run, ensureWorktree returns the preserved worktree. The spec-kit
  // phases are the first real file writes.
  const workdir = await ensureWorktree(r.title);
  // Load the spec-kit templates on demand (the chat branch above never reaches here, so chat never fetches).
  const templates = await deps.specKit();
  const p: PhaseDeps = { deps, templates, workdir, askUser, ...(r.language ? { language: r.language } : {}) };

  // Resume checkpoint lives at the worktree ROOT (one level above `base/`), so it is never committed.
  // `done` = phases a prior interrupted run already finished; skip them and continue from the first gap.
  const root = dirname(workdir);
  const prior = readCheckpoint(root);
  const done = new Set<UpstreamPhase>(prior?.done ?? []);
  // Reuse the prior feature slug so resume writes into the SAME specs/NNN-… dir (not a fresh numbered one).
  const slug = prior?.featureSlug ?? nextFeatureSlug(workdir, r.title);
  const paths = scaffoldFeature(workdir, slug);
  const specRel = relative(workdir, paths.spec);
  const planRel = relative(workdir, paths.plan);
  // Deferred (non-blocking) findings accumulated across stages — restored from the checkpoint so a restart
  // does not lose what earlier reviews chose not to block on.
  let carryOver: string[] = prior?.carryOver ?? [];
  // The checkpoint's key is the ORIGINAL request, and a resume must not overwrite it with the word that
  // triggered the resume: after one "devam et", every resumed worktree would be keyed "devam et" — colliding
  // with each other and no longer matching an exact re-run of the request that actually started the work.
  const rawPrompt = prior?.rawPrompt ?? prompt;
  const save = (): void => writeCheckpoint(root, { rawPrompt, refinedPrompt: r.refinedPrompt, title: r.title, language: r.language, intent: r.intent, featureSlug: slug, done: [...done], carryOver });
  const mark = (phase: UpstreamPhase): void => { done.add(phase); save(); };
  if (done.size > 0) emit({ kind: "note", text: `⏩ Resuming — already done: ${[...done].join(", ")}. Continuing from the next phase.` });
  // Seed the checkpoint immediately so even a crash before the first phase completes leaves a resumable marker.
  save();

  // An authoring phase can finish WITHOUT writing its file (the model answers in prose and never calls
  // write_file). Reviewing a missing document is pure waste: every lens correctly reports "it does not exist",
  // the revision cannot fix a file that was never written, and the whole round budget burns for nothing.
  // So: verify the artifact exists, retry the phase ONCE, and fail loudly rather than review nothing.
  const ensureWritten = async (file: string, rel: string, phase: string, run: () => Promise<void>, optional = false): Promise<void> => {
    if (existsSync(file)) return;
    emit({ kind: "note", text: `⚠️ The ${phase} phase produced no \`${rel}\` — retrying it once.` });
    await run();
    if (existsSync(file)) return;
    // Required artifacts (spec/plan/tasks) gate everything downstream → fail loudly. An optional one (the
    // constitution is read "if present") must not kill an otherwise healthy run — warn and carry on.
    if (!optional) throw new Error(`${phase} did not produce ${rel} (the role never wrote the file)`);
    emit({ kind: "note", text: `⚠️ Continuing without \`${rel}\` — the ${phase} phase never wrote it.` });
  };

  // Constitution: establish project principles once — only if this worktree has none yet.
  if (!done.has("constitution")) {
    if (!existsSync(constitutionPath(workdir))) {
      emitPhase("constitution");
      await runConstitution(p);
      await ensureWritten(constitutionPath(workdir), relative(workdir, constitutionPath(workdir)), "constitution", () => runConstitution(p), true);
      await commitStep(deps, workdir, "establish the project constitution");
    }
    mark("constitution");
  }

  // Brainstorm: decide the APPROACH with the user before anything is specified. Without it the first real
  // design decision was made implicitly by whoever wrote the spec, and only surfaced in review — where
  // changing it is expensive. This is the one phase where talking to the user is the point; everything
  // downstream is autonomous precisely BECAUSE the decision was made here.
  // A checkpoint written before this phase existed has no "brainstorm" in `done`, and a spec on disk proves
  // the approach was already settled — brainstorming it now would ask the user to decide work that is done.
  if (!done.has("brainstorm") && !existsSync(paths.spec)) {
    emitPhase("brainstorm");
    // Skip authoring if a brief is already there (a resumed run), exactly like spec/plan. Optional: a brief
    // the model failed to write must not kill the run — the spec prompt simply finds no file to read.
    await ensureWritten(paths.brainstorm, relative(workdir, paths.brainstorm), "brainstorm",
      () => runBrainstorm(p, paths, r.refinedPrompt), true);
    await commitStep(deps, workdir, "record the design decision");
  }
  mark("brainstorm"); // marked either way: a skipped brainstorm must not be retried on the next resume

  // Specify → council/judge review loop (revise = re-run specify with feedback).
  if (!done.has("spec")) {
    emitPhase("specify");
    // A phase is "done" only once its review passes, so an interrupt DURING the review leaves it unmarked.
    // The document itself is already written (and committed per-write) — re-authoring it would throw that work
    // away and start the review from scratch. If the artifact exists, go straight to reviewing it.
    if (existsSync(paths.spec)) {
      emit({ kind: "note", text: `⏩ \`${specRel}\` already written — resuming at its review instead of rewriting it.` });
    } else {
      await runSpecify(p, paths, r.refinedPrompt);
      await ensureWritten(paths.spec, specRel, "specify", () => runSpecify(p, paths, r.refinedPrompt));
    }
    const specOut = await runReviewLoop(deps, {
      stage: "spec", workdir, target: specRel, request: r.refinedPrompt,
      revise: (fb) => runSpecify(p, paths, r.refinedPrompt, fb),
      askUser, maxRounds, emit, language: r.language,
    });
    if (!specOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "spec" };
    // Accumulate (never overwrite): a later stage should see everything earlier stages chose not to block on.
    carryOver = [...carryOver, ...(specOut.deferred ?? [])];
    save(); // deferred notes must survive a restart, not just live in this process
    if (appendReviewNotes(paths.dir, specOut.deferred ?? [])) emit({ kind: "note", text: `📝 ${specOut.deferred!.length} deferred spec note(s) recorded in \`${relative(workdir, paths.dir)}/review-notes.md\`.` });
    // Approved but the file doesn't exist (specify didn't write it, judge passed anyway): don't hand H a nonexistent path.
    if (!existsSync(paths.spec)) throw new Error(`specify did not produce a spec: ${specRel}`);
    await commitStep(deps, workdir, "add the feature specification");
    mark("spec");
  }

  // Clarify: structured Q&A loop that tightens the spec before planning (capped inside runClarify).
  if (!done.has("clarify")) {
    emitPhase("clarify");
    await runClarify(p, paths);
    await commitStep(deps, workdir, "clarify the feature specification");
    mark("clarify");
  }

  // Plan → council/judge review loop (revise = re-run plan with feedback).
  if (!done.has("plan")) {
    emitPhase("plan");
    if (existsSync(paths.plan)) {
      emit({ kind: "note", text: `⏩ \`${planRel}\` already written — resuming at its review instead of rewriting it.` });
    } else {
      await runPlan(p, paths, undefined, carryOver);
      await ensureWritten(paths.plan, planRel, "plan", () => runPlan(p, paths, undefined, carryOver));
    }
    const planOut = await runReviewLoop(deps, {
      stage: "plan", workdir, target: planRel, request: r.refinedPrompt,
      revise: (fb) => runPlan(p, paths, fb),
      askUser, maxRounds, emit, language: r.language,
    });
    if (!planOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "plan" };
    carryOver = [...carryOver, ...(planOut.deferred ?? [])]; // spec + plan deferrals both reach the task breakdown
    save();
    if (appendReviewNotes(paths.dir, planOut.deferred ?? [])) emit({ kind: "note", text: `📝 ${planOut.deferred!.length} deferred plan note(s) recorded in \`${relative(workdir, paths.dir)}/review-notes.md\`.` });
    if (!existsSync(paths.plan)) throw new Error(`plan did not produce a plan: ${planRel}`);
    await commitStep(deps, workdir, "add the implementation plan");
    mark("plan");
  }

  // Tasks: break the approved plan into the actionable task list handed downstream to the project-manager.
  if (!done.has("tasks")) {
    emitPhase("tasks");
    await runTasks(p, paths, carryOver);
    // The board is built by reading this file — an empty/missing task list would silently produce no work.
    await ensureWritten(paths.tasks, relative(workdir, paths.tasks), "tasks", () => runTasks(p, paths, carryOver));
    await commitStep(deps, workdir, "break the plan into tasks");
    mark("tasks");
  }

  return {
    intent: r.intent,
    refinedPrompt: r.refinedPrompt,
    kind: "approved",
    specPath: specRel,
    planPath: planRel,
    tasksPath: relative(workdir, paths.tasks),
  };
}
