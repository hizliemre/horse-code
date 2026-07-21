import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { readOnlyRegistry, runReviewer } from "./reviewer.js";
import { ArchitectPlanSchema } from "./council.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";

export interface ConflictDeps extends EscalationDeps {
  manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge">;
}

export type ConflictResult = { status: "resolved" } | { status: "unresolved"; task: TaskWorktree };

/** Resolver toolset: file editing (read/write/edit/grep/glob) + skill — NO SHELL. */
function resolverRegistry(deps: ConflictDeps): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  return r;
}

/** Whether any of the given files still contains a conflict marker (`<<<<<<<`). */
async function hasConflictMarkers(baseWorktree: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    try {
      const content = await readFile(join(baseWorktree, f), "utf8");
      if (content.includes("<<<<<<<")) return true;
    } catch {
      // the file may have been deleted during resolution (delete/modify) → treat as no marker
    }
  }
  return false;
}

/**
 * Resolves a conflict in the mid-merge base worktree via council: architect diagnosis → senior-coder resolve
 * (no shell) → marker scan + code-reviewer → commitMerge. If unresolved after N rounds, abortMerge + ask a human.
 */
export async function runConflictCouncil(
  deps: ConflictDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
  task: TaskWorktree,
): Promise<ConflictResult> {
  if (!board.get(taskId)) throw new Error(`runConflictCouncil: unknown task: ${taskId}`);
  const conflicted = await deps.manager.unmergedFiles(session);
  const rounds = Math.max(1, deps.rounds);
  const base = session.baseWorktree;

  for (;;) {
    for (let i = 0; i < rounds; i++) {
      const card = board.get(taskId)!;
      const notes = card.reviewNotes.length
        ? `\nHints:\n${card.reviewNotes.map((n) => `- ${n}`).join("\n")}`
        : "";

      // 1. architect diagnosis (read-only)
      const arch = deps.roleRegistry.resolve("architect");
      const diagOpts: RoleAgentOptions = {
        provider: deps.provider, model: arch.model, systemPrompt: arch.systemPrompt,
        tools: readOnlyRegistry(deps),
        messages: [{ role: "user", content:
          `The base worktree has a merge conflict in the following files: ${conflicted.join(", ")}. ` +
          `Identify the root cause and produce a concrete resolution plan.${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
      };
      const plan = await runStructuredRole(diagOpts, ArchitectPlanSchema);
      board.appendStage(taskId, { role: "architect", action: "conflict:diagnosed", note: plan.rootCause });

      // 2. senior-coder resolve (no shell)
      const sr = deps.roleRegistry.resolve("senior-coder");
      const resolveOpts: RoleAgentOptions = {
        provider: deps.provider, model: sr.model, systemPrompt: sr.systemPrompt,
        tools: resolverRegistry(deps),
        messages: [{ role: "user", content:
          `Resolve the merge conflicts in the following files in the base worktree (remove all conflict markers ` +
          `— <<<<<<< / ======= / >>>>>>> — and merge the two changes consistently): ` +
          `${conflicted.join(", ")}.\nPlan:\n${plan.plan.map((p) => `- ${p}`).join("\n")}${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
      };
      await runToCompletion(resolveOpts);
      board.appendStage(taskId, { role: "senior-coder", action: "conflict:resolved-attempt" });

      // 3. verify: deterministic marker scan + code-reviewer
      if (await hasConflictMarkers(base, conflicted)) {
        // reviewNotes = reason the last round failed (symmetric with the reviewer-fail branch: clear+set)
        board.clearReviewNotes(taskId);
        board.addReviewNote(taskId, `conflict markers still present: ${conflicted.join(", ")}`);
        continue;
      }
      const v = await runReviewer(deps, board.get(taskId)!, base);
      if (v.verdict === "pass") {
        await deps.manager.commitMerge(session, `hc: conflict resolution — ${card.title}`);
        board.appendStage(taskId, { role: "code-reviewer", action: "conflict:merged" });
        return { status: "resolved" };
      }
      board.clearReviewNotes(taskId);
      for (const n of v.notes) board.addReviewNote(taskId, n);
    }

    // rounds exhausted, base still mid-merge → ask a human
    const decision = await deps.askHuman({
      card: board.get(taskId)!,
      verdict: { verdict: "fail", notes: [`merge conflict not resolved in ${rounds} rounds`] },
    });
    if (decision.action === "retry") {
      board.clearReviewNotes(taskId);
      for (const n of decision.notes) board.addReviewNote(taskId, n);
      continue;
    }
    // accept/abandon → abort (no commit with markers/left incomplete)
    await deps.manager.abortMerge(session);
    board.appendStage(taskId, { role: "human", action: "conflict:aborted" });
    return { status: "unresolved", task };
  }
}
