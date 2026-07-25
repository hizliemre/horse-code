import { existsSync } from "node:fs";
import { relative, dirname } from "node:path";
import type { Message } from "../core/types.js";
import type { ReviewDeps, AskUser } from "./review.js";
import { runRefiner, routeIntent, type Intent } from "./refiner.js";
import { runCoachChat } from "./coach.js";
import { extractListBlock } from "./next-steps.js";
import { runReviewLoop } from "./review.js";
import { commitStep } from "./operational.js";
import { readCheckpoint, writeCheckpoint, type UpstreamPhase, type Checkpoint } from "./checkpoint.js";
import { appendReviewNotes } from "./review-notes.js";
import type { ProgressEvent } from "./progress.js";
import { constitutionPath, nextFeatureSlug, scaffoldFeature } from "../speckit/layout.js";
import type { PhaseDeps } from "../speckit/phases.js";
import { runConstitution, runSpecify, runPlan, runTasks } from "../speckit/phases.js";
import { runClarify } from "../speckit/clarify.js";

export { buildAskUserTool } from "./writer-registry.js";

export type UpstreamResult =
  | { intent: Intent; refinedPrompt: string; kind: "chat"; response: string; nextSteps: string[]; rules: string[]; remembered: string[]; lessons: string[] }
  | { intent: Intent; refinedPrompt: string; kind: "approved"; specPath: string; planPath: string; tasksPath: string }
  | { intent: Intent; refinedPrompt: string; kind: "rejected"; stage: "spec" | "plan" };

/**
 * Upstream pipeline: refiner → route; chat→coach response; feature/bugfix→spec-kit phases
 * (constitution → specify → clarify → plan → tasks) with the council/judge review loop after spec AND plan.
 * On approval returns {specPath, planPath, tasksPath}; if rejected, {rejected, stage}.
 */
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
): Promise<UpstreamResult> {
  // Each spec-kit phase is driven by a specific role — surface it (+ its model) in the status detail so the
  // user sees WHO is working (e.g. "Writing spec… — analyst · cc/opus-4-8"), not just the persistent coach badge.
  const PHASE_ROLE: Record<string, string> = { constitution: "analyst", specify: "analyst", clarify: "analyst", plan: "planner", tasks: "project-manager" };
  const emitPhase = (phase: string): void => {
    const role = PHASE_ROLE[phase];
    const model = role ? deps.roleRegistry.peekModel(role) : "";
    emit({ kind: "phase", phase, detail: role ? `${role} · ${model}` : undefined });
  };
  // Resume: a "continue" request reuses the checkpoint's refined prompt/title/language directly — no refiner
  // pass, no re-classification. Otherwise the refiner sees the history → follow-ups are refined in context.
  // Refiner + chat run WITHOUT a worktree (read-only / classify); the worktree is opened lazily below,
  // only for the feature/bugfix pipeline — so a plain chat never creates a worktree.
  const r = resume
    ? { intent: "feature" as Intent, refinedPrompt: resume.refinedPrompt, title: resume.title, language: resume.language }
    : await runRefiner(deps, prompt, history);
  // Surface the refined prompt as soon as it's ready → the UI can replace the raw prompt before the
  // coach/pipeline runs (the refined prompt is what actually gets handed downstream).
  emit({ kind: "refined", refinedPrompt: r.refinedPrompt });
  if (!resume && routeIntent(r.intent) === "chat") {
    // Refine is done → the coach now works. Emit the phase change here (not after) so the UI shows the
    // coach-waiting status ("zottiring…") while the coach runs, not the refine status.
    emit({ kind: "phase", phase: "chat" });
    // Chat: no worktree — the coach reads the repo in place (cwd ".") + history → a contextual response.
    const raw = await runCoachChat(deps, r.refinedPrompt, ".", history, r.language, images);
    const ns = extractListBlock(raw, "nextsteps"); // suggested follow-ups
    const ru = extractListBlock(ns.text, "rule"); // durable behavioral rules → always-honored memory
    const rm = extractListBlock(ru.text, "remember"); // durable facts to persist to memory
    const ls = extractListBlock(rm.text, "lesson"); // lessons learned from a correction/failure
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "chat", response: ls.text, nextSteps: ns.items, rules: ru.items, remembered: rm.items, lessons: ls.items };
  }

  // Feature/bugfix → open the worktree now; name it from the refiner's short English title (not the raw
  // prompt slug). If this is a resumed run, ensureWorktree returns the preserved worktree. The spec-kit
  // phases are the first real file writes.
  const workdir = await ensureWorktree(r.title);
  // Load the spec-kit templates on demand (the chat branch above never reaches here, so chat never fetches).
  const templates = await deps.specKit();
  const p: PhaseDeps = { deps, templates, workdir, askUser };

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
  const save = (): void => writeCheckpoint(root, { rawPrompt: prompt, refinedPrompt: r.refinedPrompt, title: r.title, language: r.language, featureSlug: slug, done: [...done] });
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

  // Medium/low findings the spec review deferred (instead of spending another revision round on them) travel
  // to the plan phase as known, non-blocking context. Empty on a resumed run that skipped the spec phase.
  let carryOver: string[] = [];

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
