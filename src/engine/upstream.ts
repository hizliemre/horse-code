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

const askUserParams = z.object({ question: z.string() });

/** Analyst'in kullanıcıya soru sorması için tool (buildSkillTool paterni); cevabı content'te döner. */
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

/** Dosya-yazan rollerin toolset'i: read/write/edit/grep/glob + skill (+ extra); shell/web YOK. */
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

/** Analyst: ask_user ile soru sorup spec dosyasını yazar (revize'de feedback ile). */
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

/** Planner: spec'i okuyup plan dosyasını yazar (revize'de feedback ile). ask_user YOK — soru sormaz. */
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
 * Upstream pipeline: refiner → route; chat→coach cevabı; pipeline→analyst spec (F2 review) →
 * planner plan (F2 review) → onaylı {specPath, planPath}; reddedilirse {rejected, stage}.
 */
export async function runUpstream(
  deps: ReviewDeps,
  workdir: string,
  prompt: string,
  askUser: AskUser,
  maxRounds: number,
  history: Message[] = [],
): Promise<UpstreamResult> {
  // Refiner geçmişi görür → follow-up'lar bağlamda refine edilir (horse-code'un feature'ı her yerde geçerli).
  const r = await runRefiner(deps, prompt, history);
  if (routeIntent(r.intent) === "chat") {
    // Chat: refine edilmiş prompt + konuşma geçmişi → bağlamsal, tutarlı çok-turlu cevap.
    const response = await runCoachChat(deps, r.refinedPrompt, workdir, history);
    return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "chat", response };
  }

  const specPath = ".hc/spec.md";
  await runAnalyst(deps, workdir, specPath, r.refinedPrompt, undefined, askUser);
  const specOut = await runReviewLoop(
    deps, workdir, specPath,
    (fb) => runAnalyst(deps, workdir, specPath, r.refinedPrompt, fb, askUser),
    askUser, maxRounds,
  );
  if (!specOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "spec" };
  // Onaylı ama dosya yoksa (analyst yazmadı, judge yine de geçti): H'ye var-olmayan path verme.
  if (!existsSync(join(workdir, specPath))) throw new Error(`analyst spec üretmedi: ${specPath}`);

  const planPath = ".hc/plan.md";
  await runPlanner(deps, workdir, planPath, specPath, undefined);
  const planOut = await runReviewLoop(
    deps, workdir, planPath,
    (fb) => runPlanner(deps, workdir, planPath, specPath, fb),
    askUser, maxRounds,
  );
  if (!planOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "plan" };
  if (!existsSync(join(workdir, planPath))) throw new Error(`planner plan üretmedi: ${planPath}`);

  return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "approved", specPath, planPath };
}
