import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import { commitFile } from "./operational.js";
import { memoryHints } from "./memory-inject.js";
import type { TaskCycleDeps, RunnableRole } from "./task-types.js";

// A real coding task (scaffold a project, write code + tests, iterate until green) legitimately needs far
// more turns than the 50-turn default meant for short role agents. Give the implementer a generous budget so
// a large-but-healthy task isn't cut off mid-work; a genuinely stuck task still hits this ceiling and, thanks
// to per-task error isolation in runWaveTask, fails ONLY that task instead of crashing the whole job.
const IMPLEMENTER_MAX_TURNS = 200;

/** Runs the implementer role with worktree-scoped tools + a new-vs-returning message. */
export async function runImplementer(
  deps: TaskCycleDeps,
  role: RunnableRole,
  task: Card,
  cwd: string,
  /** Position among the workers running this SAME role in parallel → each leads with a different chain link. */
  slot = 0,
): Promise<void> {
  const resolved = deps.roleRegistry.resolve(role);
  const chain = deps.roleRegistry.chainFor(role, slot);
  // Per-agent metering, exactly as the review lenses do it — the live row shows what this worker is spending
  // WHILE it spends it, and renames itself if its chain slides to another model.
  const tok = { promptTokens: 0, completionTokens: 0 };
  let serving = chain[0] ?? "";
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));

  const returning = task.reviewNotes.length > 0;
  const content = returning
    ? `This is a RETURNING task: "${task.title}". Address the reviewer notes:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `This is a NEW task: "${task.title}". Implement it.`;
  // Conventions, gotchas and lessons earlier runs recorded about THIS codebase — the implementer used to be
  // blind to them and kept re-learning the same things.
  const hints = memoryHints(deps, `${task.title} ${task.reviewNotes.join(" ")}`, { role });

  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    ...(chain.length ? { model: chain[0], fallbacks: chain.slice(1) } : {}),
    tools,
    maxTurns: IMPLEMENTER_MAX_TURNS,
    messages: hints.message ? [{ role: "user", content: hints.message }, { role: "user", content }] : [{ role: "user", content }],
    onUsage: (u) => {
      tok.promptTokens += u.promptTokens;
      tok.completionTokens += u.completionTokens;
      if (u.model && u.model !== serving) { serving = u.model; deps.onProgress?.({ kind: "agent-model", id: task.id, model: serving }); }
      deps.onProgress?.({ kind: "agent-usage", id: task.id, ...tok });
    },
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
    onActivity: deps.onActivity,
    onLiveActivity: deps.onLiveActivity,
    onWrite: (path) => commitFile(deps, cwd, path).then(() => {}), // per-write conventional commit in the task worktree
  };
  await runToCompletion(opts);
}
