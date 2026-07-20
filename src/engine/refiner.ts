import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps } from "./task-types.js";

export type Intent = "chat" | "feature" | "bugfix";
export interface RefinerOutput {
  refinedPrompt: string;
  intent: Intent;
}
export const RefinerSchema = z.object({
  refinedPrompt: z.string(),
  intent: z.enum(["chat", "feature", "bugfix"]),
});

/** Kullanıcı prompt'unu refine eder + intent sınıflandırır (structured, repo tool'u yok). */
export async function runRefiner(deps: TaskCycleDeps, prompt: string): Promise<RefinerOutput> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("refiner");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools,
    messages: [{ role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
  };
  return runStructuredRole(opts, RefinerSchema);
}

/** Deterministik intent route: chat → coach; feature/bugfix → upstream pipeline. */
export function routeIntent(intent: Intent): "chat" | "pipeline" {
  return intent === "chat" ? "chat" : "pipeline";
}
