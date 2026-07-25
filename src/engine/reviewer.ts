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
import { proposeMemoryTool } from "../tools/propose-memory.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";

/**
 * Budget for the agents that inspect real CODE (the per-task reviewer, the acceptance gate). Wider than a
 * document lens — they may open several files — but bounded: an unbounded read loop re-sends everything it has
 * read on every turn, which is how one reviewer burned 1.9M prompt tokens for 21k of output.
 */
export const CODE_REVIEW_MAX_TURNS = 25;
/** Wall-clock ceiling, so one stuck reviewer cannot hold a task open indefinitely. */
export const CODE_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  notes: z.array(z.string()),
});

/** Reviewer's read-only toolset: read/grep/glob + skill (NO write/edit/shell). Coach also gets remember_fact + MCP tools. */
export function readOnlyRegistry(deps: TaskCycleDeps, opts: { remember?: boolean; propose?: boolean; mcp?: boolean } = {}): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  if (opts.remember) r.register(rememberFactTool);
  // Review agents get a voice, not a pen: propose_memory queues a signal for the curator, it never writes.
  if (opts.propose) r.register(proposeMemoryTool);
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
    tools: readOnlyRegistry(deps, { propose: true }),
    proposeMemory: (t, k) => deps.proposeMemory?.(t, k, "code-reviewer") ?? false,
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: AbortSignal.any([deps.signal, AbortSignal.timeout(CODE_REVIEW_TIMEOUT_MS)]),
    maxTurns: CODE_REVIEW_MAX_TURNS,
  };
  const verdict = await runStructuredRole(opts, VerdictSchema);
  reinforceUsed(deps, hints.ids, verdict.notes.join(" "), "code-reviewer");
  return verdict;
}
