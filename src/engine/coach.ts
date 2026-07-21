import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * Coach chat: answers the prompt using read-only repo tools (read/grep/glob + skill); returns the final text.
 * `history` is the previous conversation turns (user/assistant) → multi-turn session consistency (the conversation progresses).
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
