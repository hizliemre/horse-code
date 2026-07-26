import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runReviewer } from "./reviewer.js";
import { contextTools } from "./task-types.js";
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
  for (const t of contextTools(deps)) r.register(t);
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
 * Resolves a conflict in the mid-merge base worktree with the OPERATIONAL agent (the project's version-control
 * owner): it edits the conflicted files to remove markers + merge both sides → deterministic marker scan +
 * code-reviewer → commitMerge. If unresolved after N rounds, abortMerge + ask a human. (The `git merge` itself
 * stays deterministic; only the intelligent conflict resolution is delegated to the agent.)
 */
export async function resolveMergeConflict(
  deps: ConflictDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
  task: TaskWorktree,
): Promise<ConflictResult> {
  if (!board.get(taskId)) throw new Error(`resolveMergeConflict: unknown task: ${taskId}`);
  const conflicted = await deps.manager.unmergedFiles(session);
  const rounds = Math.max(1, deps.rounds);
  const base = session.baseWorktree;
  deps.note?.(`🔀 Merge conflict in ${conflicted.join(", ")} — operational resolving…`);

  for (;;) {
    for (let i = 0; i < rounds; i++) {
      const card = board.get(taskId)!;
      const notes = card.reviewNotes.length
        ? `\nHints from the last attempt:\n${card.reviewNotes.map((n) => `- ${n}`).join("\n")}`
        : "";

      // The operational agent diagnoses + resolves the conflict (file edits only — no shell).
      const op = deps.roleRegistry.resolve("operational");
      const resolveOpts: RoleAgentOptions = {
        provider: deps.provider, ...op,
        tools: resolverRegistry(deps),
        messages: [{ role: "user", content:
          `A git merge left conflicts in the base worktree. Resolve them: for EACH file, remove all conflict ` +
          `markers (<<<<<<<, =======, >>>>>>>) and combine BOTH sides' changes so the intent of each is ` +
          `preserved (don't just pick one side unless the changes are truly incompatible). ` +
          `Conflicted files: ${conflicted.join(", ")}.${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
      };
      await runToCompletion(resolveOpts);
      board.appendStage(taskId, { role: "operational", action: "conflict:resolve-attempt" });

      // verify: deterministic marker scan + code-reviewer
      if (await hasConflictMarkers(base, conflicted)) {
        // reviewNotes = reason the last round failed (symmetric with the reviewer-fail branch: clear+set)
        board.clearReviewNotes(taskId);
        board.addReviewNote(taskId, `conflict markers still present: ${conflicted.join(", ")}`);
        continue;
      }
      const v = await runReviewer(deps, board.get(taskId)!, base);
      if (v.verdict === "pass") {
        await deps.manager.commitMerge(session, `chore: resolve merge conflict — ${card.title}`);
        board.appendStage(taskId, { role: "operational", action: "conflict:merged" });
        deps.note?.(`🔖 chore: resolve merge conflict — ${card.title}`);
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
    deps.note?.(`⚠ Merge conflict could not be resolved after ${rounds} rounds — aborted.`);
    return { status: "unresolved", task };
  }
}
