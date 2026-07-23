import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { Message } from "../core/types.js";
import type { ReviewDeps, AskUser } from "./review.js";
import { runRefiner, routeIntent, type Intent } from "./refiner.js";
import { runCoachChat } from "./coach.js";
import { extractListBlock } from "./next-steps.js";
import { runReviewLoop } from "./review.js";
import { commitStep } from "./operational.js";
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
): Promise<UpstreamResult> {
  // Each spec-kit phase is driven by a specific role — surface it (+ its model) in the status detail so the
  // user sees WHO is working (e.g. "Writing spec… — analyst · cc/opus-4-8"), not just the persistent coach badge.
  const PHASE_ROLE: Record<string, string> = { constitution: "analyst", specify: "analyst", clarify: "analyst", plan: "planner", tasks: "project-manager" };
  const emitPhase = (phase: string): void => {
    const role = PHASE_ROLE[phase];
    const model = role ? deps.roleRegistry.peekModel(role) : "";
    emit({ kind: "phase", phase, detail: role ? `${role} · ${model}` : undefined });
  };
  // The refiner sees the history → follow-ups are refined in context (horse-code's feature applies everywhere).
  // Refiner + chat run WITHOUT a worktree (read-only / classify); the worktree is opened lazily below,
  // only for the feature/bugfix pipeline — so a plain chat never creates a worktree.
  const r = await runRefiner(deps, prompt, history);
  // Surface the refined prompt as soon as it's ready → the UI can replace the raw prompt before the
  // coach/pipeline runs (the refined prompt is what actually gets handed downstream).
  emit({ kind: "refined", refinedPrompt: r.refinedPrompt });
  if (routeIntent(r.intent) === "chat") {
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
  // prompt slug). The spec-kit phases are the first real file writes.
  const workdir = await ensureWorktree(r.title);
  // Load the spec-kit templates on demand (the chat branch above never reaches here, so chat never fetches).
  const templates = await deps.specKit();
  const p: PhaseDeps = { deps, templates, workdir, askUser };

  // Constitution: establish project principles once — only if this worktree has none yet.
  if (!existsSync(constitutionPath(workdir))) {
    emitPhase("constitution");
    await runConstitution(p);
    await commitStep(deps, workdir, "establish the project constitution");
  }

  const slug = nextFeatureSlug(workdir, r.title);
  const paths = scaffoldFeature(workdir, slug);

  // Specify → council/judge review loop (revise = re-run specify with feedback).
  emitPhase("specify");
  await runSpecify(p, paths, r.refinedPrompt);
  const specRel = relative(workdir, paths.spec);
  const specOut = await runReviewLoop(
    deps, workdir, specRel,
    (fb) => runSpecify(p, paths, r.refinedPrompt, fb),
    askUser, maxRounds,
    emit,
    r.language,
  );
  if (!specOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "spec" };
  // Approved but the file doesn't exist (specify didn't write it, judge passed anyway): don't hand H a nonexistent path.
  if (!existsSync(paths.spec)) throw new Error(`specify did not produce a spec: ${specRel}`);
  await commitStep(deps, workdir, "add the feature specification");

  // Clarify: structured Q&A loop that tightens the spec before planning (capped inside runClarify).
  emitPhase("clarify");
  await runClarify(p, paths);
  await commitStep(deps, workdir, "clarify the feature specification");

  // Plan → council/judge review loop (revise = re-run plan with feedback).
  emitPhase("plan");
  await runPlan(p, paths);
  const planRel = relative(workdir, paths.plan);
  const planOut = await runReviewLoop(
    deps, workdir, planRel,
    (fb) => runPlan(p, paths, fb),
    askUser, maxRounds,
    emit,
    r.language,
  );
  if (!planOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "plan" };
  if (!existsSync(paths.plan)) throw new Error(`plan did not produce a plan: ${planRel}`);
  await commitStep(deps, workdir, "add the implementation plan");

  // Tasks: break the approved plan into the actionable task list handed downstream to the project-manager.
  emitPhase("tasks");
  await runTasks(p, paths);
  await commitStep(deps, workdir, "break the plan into tasks");

  return {
    intent: r.intent,
    refinedPrompt: r.refinedPrompt,
    kind: "approved",
    specPath: specRel,
    planPath: planRel,
    tasksPath: relative(workdir, paths.tasks),
  };
}
