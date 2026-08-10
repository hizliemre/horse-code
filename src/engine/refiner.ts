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
  /**
   * The choice that decides what a run COSTS, described where it is made.
   *
   * The enum carried no descriptions at all: every definition lived in one dense paragraph of the system
   * prompt, competing with the rules for refinedPrompt, language and title. Measured live — "canlı db ve loki
   * kanıtlarını da sorgula ve işle", refined by this same call into "Query live database and Loki logs, and
   * document the evidence in the test report", was classified `feature`. It then ran constitution and
   * brainstorm and opened `specs/006-db-loki-evidence` before anyone noticed that producing a test report
   * needs no specification. The prompt's own words for `verify` describe that request exactly; they were just
   * nowhere near the field being filled in.
   */
  intent: z.enum(["chat", "feature", "bugfix", "govern", "undo", "verify"]).describe(
    "What the request PRODUCES, not what it mentions. "
    + "`verify`: a record of what EXISTING software DID — running scenarios, querying the database or logs "
    + "for evidence, writing or extending a test report. Anything whose output is findings rather than "
    + "changed behaviour is verify, including a follow-up that only adds more evidence to a report already "
    + "being written. "
    + "`feature`: new or changed behaviour in the product. `bugfix`: existing behaviour is wrong and must be "
    + "corrected. `govern`: the output is a governing document (constitution, conventions), no source changes. "
    + "`undo`: reverse what the previous turn did. `chat`: a question or conversation, nothing to build. "
    + "A verify request never needs a specification or a plan: if the answer is 'run it and write down what "
    + "happened', it is verify."),
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
