import { z } from "zod";
import type { Card } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { gitTool } from "../tools/git.js";
import { applySkills, buildSkillTool } from "../skills/apply.js";
import { rememberFactTool } from "../tools/remember.js";
import { proposeMemoryTool } from "../tools/propose-memory.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { routeSkills, filesForTask } from "../skills/route.js";
import { placedSkills } from "../prompts.js";
import { loadGraphSync } from "./project-graph.js";
import { contextTools, projectToolsNote, BATCH_TOOLS_NOTE } from "./task-types.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";
import { taskDiff, describeDiff } from "./task-diff.js";

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

/**
 * Reviewer's read-only toolset: read/grep/glob + skill (NO write/edit/shell), plus every read-only MCP tool.
 *
 * `opts.mcp` additionally grants the tools that can MUTATE — only the coach gets those.
 */
export function readOnlyRegistry(deps: TaskCycleDeps, opts: { remember?: boolean; propose?: boolean; mcp?: boolean } = {}): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(grepTool);
  r.register(globTool);
  // What only git knows: what changed, when, and how this branch compares to another. Read-only by
  // construction — see src/tools/git.ts.
  r.register(gitTool);
  r.register(buildSkillTool(deps.skillRegistry));
  for (const t of contextTools(deps)) r.register(t);
  if (opts.remember) r.register(rememberFactTool);
  // Review agents get a voice, not a pen: propose_memory queues a signal for the curator, it never writes.
  if (opts.propose) r.register(proposeMemoryTool);
  // The mutating ones, on top — registering a read-only tool twice is a no-op the registry absorbs.
  if (opts.mcp) for (const t of deps.mcpTools?.() ?? []) r.register(t);
  return r;
}

/** Runs the code-reviewer role with read-only tools and returns a structured verdict. */
export async function runReviewer(deps: TaskCycleDeps, task: Card, cwd: string): Promise<Verdict> {
  const resolved = deps.roleRegistry.resolve("code-reviewer");
  const hints = memoryHints(deps, task.title, { role: "code-reviewer" });
  // A reviewer is exactly where a read-only auditing skill belongs — the skills an implementer must not be
  // handed, because they refuse to write code, are the ones that judge it best.
  const reviewerTools = readOnlyRegistry(deps, { propose: true });
  const routed = routeSkills(task.title, deps.skillRegistry, deps.roleRegistry.skillsFor("code-reviewer"), {
    // The card's own files, never a guess: see the implementer for the measurement that settled it.
    role: "code-reviewer", files: task.files, placed: placedSkills(),
  });
  if (routed.length) deps.note?.(`📎 \`code-reviewer\` · ${routed.map((m) => `**${m.name}**`).join(", ")}`);
  // Handed, not hunted: a reviewer that spends its budget FINDING the change has none left to judge it.
  const diff = deps.baseRef ? await taskDiff(cwd, deps.baseRef) : "";
  const ask = { role: "user" as const, content:
    `Review the CODE that implements task "${task.title}" — correctness, tests, and implementation quality.\n` +
    `The subject of this review is ALWAYS the code. Do NOT review, re-open, or comment on the upstream ` +
    `planning documents (specs/**, .specify/**, plan.md, tasks.md) — they were already reviewed and approved ` +
    `before coding began; treat them as fixed context, not as something to critique.\n` +
    `Give a verdict (pass/fail + notes).\n\n${describeDiff(diff)}` };
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    systemPrompt: (routed.length
      ? applySkills(resolved.systemPrompt, routed.map((m) => m.name), deps.skillRegistry)
      : resolved.systemPrompt) + projectToolsNote(reviewerTools.list(), !!loadGraphSync(cwd)) + BATCH_TOOLS_NOTE,
    tools: reviewerTools,
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
