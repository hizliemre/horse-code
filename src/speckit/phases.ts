import { relative } from "node:path";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { writerRegistry, buildAskUserTool } from "../engine/writer-registry.js";
import { commitFile } from "../engine/operational.js";
import type { TaskCycleDeps } from "../engine/task-types.js";
import type { AskUser } from "../engine/review.js";
import type { SpecKitTemplates } from "./templates.js";
import type { FeaturePaths } from "./layout.js";
import { constitutionPath } from "./layout.js";

export interface PhaseDeps { deps: TaskCycleDeps; templates: SpecKitTemplates; workdir: string; askUser: AskUser }

// Common framing: spec-kit command prompts assume bash scaffolding scripts; horse-code already scaffolds
// the workspace, so the role must skip those and just write the target file with write_file.
const SKIP = "The workspace is already scaffolded — do NOT run any shell scripts. Use write_file to write the output file exactly at the path given below.";

async function runRole(p: PhaseDeps, role: string, command: string, message: string, extraTools = false): Promise<void> {
  // fallbackOpts (not resolve): spec-kit phases drive the role with the spec-kit command prompt, so they
  // supply their own prompt — but still want the role's model CHAIN + session-fallback on exhaustion.
  const { model, fallbacks, onExhausted, onFallback } = p.deps.roleRegistry.fallbackOpts(role);
  const tools = writerRegistry(p.deps.skillRegistry, extraTools ? [buildAskUserTool(p.askUser)] : []);
  const opts: RoleAgentOptions = {
    provider: p.deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: `${command}\n\n${SKIP}${p.deps.roleRegistry.ruleSuffix()}`,
    tools,
    messages: [{ role: "user", content: message }],
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

export async function runPlan(p: PhaseDeps, paths: FeaturePaths, feedback?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.plan);
  const specRel = relative(p.workdir, paths.spec);
  const cRel = relative(p.workdir, constitutionPath(p.workdir));
  const msg = feedback?.length
    ? `Revise the plan at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}`
    : `Read the spec "${specRel}" and the constitution "${cRel}" (if present).\n` +
      `Follow this template:\n\n${p.templates.template("plan")}\n\nWrite the plan to "${rel}".`;
  await runRole(p, "planner", p.templates.command("plan"), msg);
}

export async function runTasks(p: PhaseDeps, paths: FeaturePaths): Promise<void> {
  const rel = relative(p.workdir, paths.tasks);
  const planRel = relative(p.workdir, paths.plan);
  const msg =
    `Read the plan "${planRel}" and break it into an actionable task list.\n` +
    `Follow this template:\n\n${p.templates.template("tasks")}\n\nWrite the tasks to "${rel}".`;
  await runRole(p, "project-manager", p.templates.command("tasks"), msg);
}
