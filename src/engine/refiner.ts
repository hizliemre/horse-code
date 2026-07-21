import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps } from "./task-types.js";

export type Intent = "chat" | "feature" | "bugfix";
export interface RefinerOutput {
  refinedPrompt: string;
  intent: Intent;
  language: string;
  title: string;
}
export const RefinerSchema = z.object({
  refinedPrompt: z.string(),
  intent: z.enum(["chat", "feature", "bugfix"]),
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
  const { model, systemPrompt } = deps.roleRegistry.resolve("refiner");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools,
    messages: [...history, { role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
  };
  return runStructuredRole(opts, RefinerSchema);
}

/** Deterministic intent routing: chat → coach; feature/bugfix → upstream pipeline. */
export function routeIntent(intent: Intent): "chat" | "pipeline" {
  return intent === "chat" ? "chat" : "pipeline";
}
