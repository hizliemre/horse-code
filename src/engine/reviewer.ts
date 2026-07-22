import { z } from "zod";
import type { Card } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import { rememberFactTool } from "../tools/remember.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

export const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  notes: z.array(z.string()),
});

/** Reviewer's read-only toolset: read/grep/glob + skill (NO write/edit/shell). Coach also gets remember_fact. */
export function readOnlyRegistry(deps: TaskCycleDeps, opts: { remember?: boolean } = {}): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  if (opts.remember) r.register(rememberFactTool);
  return r;
}

/** Runs the code-reviewer role with read-only tools and returns a structured verdict. */
export async function runReviewer(deps: TaskCycleDeps, task: Card, cwd: string): Promise<Verdict> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("code-reviewer");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [
      { role: "user", content: `Review the worktree changes for task "${task.title}"; give a verdict (pass/fail + notes).` },
    ],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  return runStructuredRole(opts, VerdictSchema);
}
