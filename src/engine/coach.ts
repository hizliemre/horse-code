import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * Coach chat: salt-okunur repo tool'larıyla (read/grep/glob + skill) prompt'u yanıtlar; final metni döner.
 * `history` önceki konuşma turnleri (user/assistant) → çok-turlu session tutarlılığı (conversation ilerler).
 */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string, history: Message[] = []): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [...history, { role: "user", content: prompt }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}
