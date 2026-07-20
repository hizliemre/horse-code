import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

/** Coach chat: salt-okunur repo tool'larıyla (read/grep/glob + skill) tek prompt'u yanıtlar; final metni döner. */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}
