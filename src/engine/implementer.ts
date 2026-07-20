import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, ImplementerRole } from "./task-types.js";

/** Implementer role'ünü worktree-scope'lu tool'lar + yeni-vs-dönen mesajıyla çalıştırır. */
export async function runImplementer(
  deps: TaskCycleDeps,
  role: ImplementerRole,
  task: Card,
  cwd: string,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve(role);
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));

  const returning = task.reviewNotes.length > 0;
  const content = returning
    ? `Bu bir DÖNEN task: "${task.title}". Reviewer notlarını gider:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `Bu YENİ bir task: "${task.title}". Uygula.`;

  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools,
    messages: [{ role: "user", content }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  await runToCompletion(opts);
}
