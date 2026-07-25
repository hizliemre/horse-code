import { relative } from "node:path";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { writerRegistry, buildAskUserTool } from "../engine/writer-registry.js";
import { commitFile } from "../engine/operational.js";
import { normalizeQuestion } from "../engine/normalize-question.js";
import { memoryHints } from "../engine/memory-inject.js";
import type { TaskCycleDeps } from "../engine/task-types.js";
import type { AskUser } from "../engine/review.js";
import type { SpecKitTemplates } from "./templates.js";
import type { FeaturePaths } from "./layout.js";
import { constitutionPath } from "./layout.js";

export interface PhaseDeps { deps: TaskCycleDeps; templates: SpecKitTemplates; workdir: string; askUser: AskUser }

// Common framing: spec-kit command prompts assume bash scaffolding scripts; horse-code already scaffolds
// the workspace, so the role must skip those and just write the target file with write_file.
const SKIP = "The workspace is already scaffolded — do NOT run any shell scripts. Use write_file to write the output file exactly at the path given below.";

// Authoring a spec/plan (and revising it across review rounds) legitimately needs far more tool-round turns
// than the 50-turn default meant for short agents — a big doc with clarify Q&A + several revise passes can
// exceed 50 read/edit turns in one invocation. Give the spec-kit phases a generous ceiling so a healthy phase
// isn't cut off mid-write (which would crash the whole upstream); a genuinely stuck phase still stops here.
const PHASE_MAX_TURNS = 200;

async function runRole(p: PhaseDeps, role: string, command: string, message: string, extraTools = false): Promise<void> {
  // fallbackOpts (not resolve): spec-kit phases drive the role with the spec-kit command prompt, so they
  // supply their own prompt — but still want the role's model CHAIN + session-fallback on exhaustion.
  const { model, fallbacks, onExhausted, onFallback } = p.deps.roleRegistry.fallbackOpts(role);
  const tools = writerRegistry(p.deps.skillRegistry, extraTools ? [buildAskUserTool(p.askUser, (q) => normalizeQuestion(p.deps, q))] : []);
  const hints = memoryHints(p.deps, message);
  const opts: RoleAgentOptions = {
    provider: p.deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: `${command}\n\n${SKIP}${p.deps.roleRegistry.ruleSuffix()}`,
    tools,
    maxTurns: PHASE_MAX_TURNS,
    // Project memory (conventions/decisions/lessons) reaches the authoring roles too, not just the coach.
    messages: hints.message ? [{ role: "user", content: hints.message }, { role: "user", content: message }] : [{ role: "user", content: message }],
    permission: p.deps.permission,
    approve: p.deps.approve,
    cwd: p.workdir,
    signal: p.deps.signal,
    onActivity: p.deps.onActivity,
    onLiveActivity: p.deps.onLiveActivity,
    onWrite: (path) => commitFile(p.deps, p.workdir, path).then(() => {}), // per-write conventional commit
  };
  await runToCompletion(opts);
}

export async function runConstitution(p: PhaseDeps): Promise<void> {
  const rel = relative(p.workdir, constitutionPath(p.workdir));
  const msg =
    `Establish the project constitution. Ask the user about core principles with ask_user if needed.\n` +
    `Follow this template:\n\n${p.templates.template("constitution")}\n\nWrite it to "${rel}".`;
  await runRole(p, "analyst", p.templates.command("constitution"), msg, true);
}

export async function runSpecify(p: PhaseDeps, paths: FeaturePaths, prompt: string, feedback?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.spec);
  const msg = feedback?.length
    ? `Revise the spec at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}\nOriginal request: ${prompt}`
    : `Feature request: "${prompt}". Ask clarifying questions with ask_user only if strictly necessary.\n` +
      `Follow this template:\n\n${p.templates.template("spec")}\n\nWrite the spec to "${rel}".`;
  await runRole(p, "analyst", p.templates.command("specify"), msg, true);
}

export async function runPlan(p: PhaseDeps, paths: FeaturePaths, feedback?: string[], carryOver?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.plan);
  const specRel = relative(p.workdir, paths.spec);
  const cRel = relative(p.workdir, constitutionPath(p.workdir));
  // Non-blocking notes the spec review deliberately deferred rather than spending another revision round on:
  // surfaced here so the plan can settle them where they actually belong, instead of being lost.
  const carried = carryOver?.length
    ? `\n\nKnown non-blocking notes carried over from the spec review — address them in the plan where they ` +
      `apply (they are context, not blockers):\n${carryOver.map((c) => `- ${c}`).join("\n")}`
    : "";
  const msg = feedback?.length
    ? `Revise the plan at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}`
    : `Read the spec "${specRel}" and the constitution "${cRel}" (if present).\n` +
      `Follow this template:\n\n${p.templates.template("plan")}\n\nWrite the plan to "${rel}".${carried}`;
  await runRole(p, "planner", p.templates.command("plan"), msg);
}

export async function runTasks(p: PhaseDeps, paths: FeaturePaths, carryOver?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.tasks);
  const planRel = relative(p.workdir, paths.plan);
  // Non-blocking notes the plan review deferred → the task list is the last place they can still be picked up.
  const carried = carryOver?.length
    ? `\n\nKnown non-blocking notes carried over from the earlier reviews — fold them into a task only where ` +
      `they genuinely apply (they are context, not new requirements):\n${carryOver.map((c) => `- ${c}`).join("\n")}`
    : "";
  const msg =
    `Read the plan "${planRel}" and break it into an actionable task list.\n` +
    `Follow this template:\n\n${p.templates.template("tasks")}\n\nWrite the tasks to "${rel}".${carried}`;
  await runRole(p, "project-manager", p.templates.command("tasks"), msg);
}
