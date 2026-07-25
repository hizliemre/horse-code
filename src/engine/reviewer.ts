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
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

export const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  notes: z.array(z.string()),
});

/** Reviewer's read-only toolset: read/grep/glob + skill (NO write/edit/shell). Coach also gets remember_fact + MCP tools. */
export function readOnlyRegistry(deps: TaskCycleDeps, opts: { remember?: boolean; mcp?: boolean } = {}): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  if (opts.remember) r.register(rememberFactTool);
  if (opts.mcp) for (const t of deps.mcpTools?.() ?? []) r.register(t);
  return r;
}

/** Runs the code-reviewer role with read-only tools and returns a structured verdict. */
export async function runReviewer(deps: TaskCycleDeps, task: Card, cwd: string): Promise<Verdict> {
  const resolved = deps.roleRegistry.resolve("code-reviewer");
  const hints = memoryHints(deps, task.title, { role: "code-reviewer" });
  const ask = { role: "user" as const, content:
    `Review the CODE that implements task "${task.title}" — correctness, tests, and implementation quality.\n` +
    `The subject of this review is ALWAYS the code. Do NOT review, re-open, or comment on the upstream ` +
    `planning documents (specs/**, .specify/**, plan.md, tasks.md) — they were already reviewed and approved ` +
    `before coding began; treat them as fixed context, not as something to critique.\n` +
    `Give a verdict (pass/fail + notes).` };
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    tools: readOnlyRegistry(deps),
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
  };
  const verdict = await runStructuredRole(opts, VerdictSchema);
  reinforceUsed(deps, hints.ids, verdict.notes.join(" "), "code-reviewer");
  return verdict;
}
