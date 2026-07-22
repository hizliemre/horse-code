import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message } from "../core/types.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * Coach chat: answers the prompt using read-only repo tools (read/grep/glob + skill); returns the final text.
 * `history` is the previous conversation turns (user/assistant) → multi-turn session consistency (the conversation progresses).
 */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string, history: Message[] = [], language?: string, images?: string[]): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  // The refined prompt is always English; tell the coach the real model + the user's original language so
  // "which model are you?" is answered truthfully and the reply comes back in the language the user used.
  const pins = deps.pins?.() ?? [];
  const pinBlock = pins.length ? `\n\nUser pins (always honor these):\n${pins.map((p) => `- ${p}`).join("\n")}` : "";
  const context = `\n\nContext: this session is powered by the "${model}" model.` +
    (language ? ` Respond in ${language}.` : "") +
    ` When it helps, end your reply with a <nextsteps> block: 2-4 short, concrete follow-up actions the` +
    ` user might pick next, one per line prefixed with "- ". Omit the block when there is no useful next step.` +
    pinBlock;
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt: systemPrompt + context,
    tools: readOnlyRegistry(deps),
    messages: [...history, { role: "user", content: prompt, ...(images?.length ? { images } : {}) }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
    inbox: deps.inbox, // "by-the-way" notes typed mid-run are folded into the coach's turn
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}
