import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, RunnableRole } from "./task-types.js";

/** Runs the implementer role with worktree-scoped tools + a new-vs-returning message. */
export async function runImplementer(
  deps: TaskCycleDeps,
  role: RunnableRole,
  task: Card,
  cwd: string,
): Promise<void> {
  const resolved = deps.roleRegistry.resolve(role);
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));

  const returning = task.reviewNotes.length > 0;
  const content = returning
    ? `This is a RETURNING task: "${task.title}". Address the reviewer notes:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `This is a NEW task: "${task.title}". Implement it.`;

  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    tools,
    messages: [{ role: "user", content }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
    onActivity: deps.onActivity,
    onLiveActivity: deps.onLiveActivity,
  };
  await runToCompletion(opts);
}
