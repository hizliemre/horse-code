import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * What the user is asking for, and therefore what machinery the request deserves.
 *
 * `undo` is the fifth, and it is the odd one: the other four all mean "produce something". A request to
 * revert the previous turn operates ON that turn, and forcing it into a produce-something bucket is how
 * "undo your change, go back to the previous version" became a third rewrite of the same document.
 *
 * `govern` is the fourth because three were not enough: establishing the project's constitution is neither a
 * conversation nor a change to the software, and classifying it as a feature bought it the entire pipeline —
 * a worktree cut from a branch, a spec, a plan, a task board, waves. None of that has anything to hold: the
 * output is one document stating the project's own principles, and it belongs in the project the user is
 * standing in, not in a branch waiting to be merged.
 */
/**
 * `verify` is the sixth, and it exists for the reason `govern` does: a request that produces no software must
 * not buy the machinery for producing software. Running an existing pull request's scenarios and recording
 * what they did is not a feature — nothing is built, the output is a report, and the developer is present
 * throughout because the environment is theirs to start and stop.
 */
export type Intent = "chat" | "feature" | "bugfix" | "govern" | "undo" | "verify";
export interface RefinerOutput {
  refinedPrompt: string;
  intent: Intent;
  language: string;
  title: string;
}
export const RefinerSchema = z.object({
  refinedPrompt: z.string().describe("The refined instruction, ALWAYS in English — translate from the user's language if needed; never output the user's original language here."),
  intent: z.enum(["chat", "feature", "bugfix", "govern", "undo", "verify"]),
  // The natural language the user wrote in (English name, e.g. "Turkish") → the coach replies in it.
  language: z.string().default("English"),
  // A concise 2-5 word English kebab-case summary → used as the worktree/branch name (e.g. "add-login-page").
  title: z.string().default("task"),
});

/**
 * Refines the user prompt + classifies intent (structured, no repo tools).
 * `history` is the previous turns → follow-ups are refined in context (e.g. "when were you developed?" after a
 * previous "you're Claude" turn gets refined toward Claude, not the project).
 */
export async function runRefiner(deps: TaskCycleDeps, prompt: string, history: Message[] = []): Promise<RefinerOutput> {
  const resolved = deps.roleRegistry.resolve("refiner");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    tools,
    messages: [...history, { role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
  };
  return runStructuredRole(opts, RefinerSchema);
}

/**
 * Deterministic routing: chat → coach; govern → in place; feature/bugfix → the full pipeline.
 *
 * Deterministic on purpose. The model decides WHAT the request is; what that costs is not a judgement call,
 * and a run that opens a worktree because a classifier hedged is a run nobody can explain.
 */
export function routeIntent(intent: Intent): "chat" | "govern" | "undo" | "verify" | "pipeline" {
  if (intent === "chat") return "chat";
  if (intent === "undo") return "undo";
  if (intent === "verify") return "verify";
  return intent === "govern" ? "govern" : "pipeline";
}
