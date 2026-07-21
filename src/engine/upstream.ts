import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, Message } from "../core/types.js";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { ReviewDeps, AskUser } from "./review.js";
import { runRefiner, routeIntent, type Intent } from "./refiner.js";
import { runCoachChat } from "./coach.js";
import { runReviewLoop } from "./review.js";
import type { ProgressEvent } from "./progress.js";

const askUserParams = z.object({ question: z.string() });

/** Tool for the analyst to ask the user a question (buildSkillTool pattern); returns the answer in content. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description: "Ask the user a question and get their answer.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const answer = await askUser(parsed.data.question);
      return { content: answer, isError: false };
    },
  };
}

/** Toolset for file-writing roles: read/write/edit/grep/glob + skill (+ extra); NO shell/web. */
function writerRegistry(deps: ReviewDeps, extra: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  for (const t of extra) r.register(t);
  return r;
}

/** Analyst: asks questions via ask_user and writes the spec file (with feedback on revision). */
export async function runAnalyst(
  deps: ReviewDeps,
  workdir: string,
  specPath: string,
  prompt: string,
  feedback: string[] | undefined,
  askUser: AskUser,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("analyst");
  const tools = writerRegistry(deps, [buildAskUserTool(askUser)]);
  const content =
    feedback && feedback.length
      ? `Revise the "${specPath}" spec with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}\nOriginal request: ${prompt}`
      : `Request: "${prompt}". If needed, ask the user via ask_user; write the spec file to "${specPath}" with write_file.`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  await runToCompletion(opts);
}

/** Planner: reads the spec and writes the plan file (with feedback on revision). NO ask_user — it doesn't ask questions. */
export async function runPlanner(
  deps: ReviewDeps,
  workdir: string,
  planPath: string,
  specPath: string,
  feedback: string[] | undefined,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("planner");
  const tools = writerRegistry(deps);
  const content =
    feedback && feedback.length
      ? `Revise the "${planPath}" plan with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}\n(from the "${specPath}" spec)`
      : `Read the "${specPath}" spec and write the plan to "${planPath}" with write_file.`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  await runToCompletion(opts);
}

export type UpstreamResult =
  | { intent: Intent; refinedPrompt: string; kind: "chat"; response: string }
  | { intent: Intent; refinedPrompt: string; kind: "approved"; specPath: string; planPath: string }
  | { intent: Intent; refinedPrompt: string; kind: "rejected"; stage: "spec" | "plan" };

/**
 * Upstream pipeline: refiner → route; chat→coach response; pipeline→analyst spec (F2 review) →
 * planner plan (F2 review) → approved {specPath, planPath}; if rejected, {rejected, stage}.
 */
export async function runUpstream(
  deps: ReviewDeps,
  ensureWorktree: () => Promise<string>,
  prompt: string,
  askUser: AskUser,
  maxRounds: number,
  history: Message[] = [],
  emit: (ev: ProgressEvent) => void = () => {},
): Promise<UpstreamResult> {
  // The refiner sees the history → follow-ups are refined in context (horse-code's feature applies everywhere).
  // Refiner + chat run WITHOUT a worktree (read-only / classify); the worktree is opened lazily below,
  // only for the feature/bugfix pipeline — so a plain chat never creates a worktree.
  const r = await runRefiner(deps, prompt, history);
  // Surface the refined prompt as soon as it's ready → the UI can replace the raw prompt before the
  // coach/pipeline runs (the refined prompt is what actually gets handed downstream).
  emit({ kind: "refined", refinedPrompt: r.refinedPrompt });
  if (routeIntent(r.intent) === "chat") {
    // Chat: no worktree — the coach reads the repo in place (cwd ".") + history → a contextual response.
    const response = await runCoachChat(deps, r.refinedPrompt, ".", history);
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "chat", response };
  }

  // Feature/bugfix → open the worktree now; the analyst's spec is the first real file write.
  const workdir = await ensureWorktree();
  const specPath = ".hc/spec.md";
  await runAnalyst(deps, workdir, specPath, r.refinedPrompt, undefined, askUser);
  const specOut = await runReviewLoop(
    deps, workdir, specPath,
    (fb) => runAnalyst(deps, workdir, specPath, r.refinedPrompt, fb, askUser),
    askUser, maxRounds,
  );
  if (!specOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "spec" };
  // Approved but the file doesn't exist (analyst didn't write it, judge passed anyway): don't hand H a nonexistent path.
  if (!existsSync(join(workdir, specPath))) throw new Error(`analyst did not produce a spec: ${specPath}`);

  const planPath = ".hc/plan.md";
  await runPlanner(deps, workdir, planPath, specPath, undefined);
  const planOut = await runReviewLoop(
    deps, workdir, planPath,
    (fb) => runPlanner(deps, workdir, planPath, specPath, fb),
    askUser, maxRounds,
  );
  if (!planOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "plan" };
  if (!existsSync(join(workdir, planPath))) throw new Error(`planner did not produce a plan: ${planPath}`);

  return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "approved", specPath, planPath };
}
