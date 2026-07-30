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
import { callSignal, LONG_CALL_MS } from "../agent/deadline.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConflictDeps extends EscalationDeps {
  manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge">;
}

export type ConflictResult = { status: "resolved" } | { status: "unresolved"; task: TaskWorktree };

/** Resolver toolset: file editing (read/write/edit/grep/glob) + skill — NO SHELL. */
/**
 * Resolving a conflict is a text edit on files git has already named. It is not an investigation.
 *
 * The resolver used to carry grep, glob, the skill loader and the code-graph tools as well, and it spent its
 * whole budget using them: measured live, a three-file conflict ended with
 * `conflict:resolve-failed: maximum turn count exceeded (50)` — fifty turns, and the merge was abandoned with
 * the task's review already passed. Tools it does not need are turns it will spend.
 */
function resolverRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  return r;
}

/**
 * A turn budget that scales with the work: a few turns per conflicted file, with a floor.
 *
 * The default of fifty was both too many (it let the resolver wander) and, for a large conflict, potentially
 * too few. Tying it to the file count says what the job actually is.
 */
export const RESOLVE_TURNS_PER_FILE = 6;
export const RESOLVE_TURNS_MIN = 12;
export function resolveTurnBudget(fileCount: number): number {
  return Math.max(RESOLVE_TURNS_MIN, fileCount * RESOLVE_TURNS_PER_FILE);
}

/**
 * The conflicted regions themselves, handed over rather than hunted for.
 *
 * Each hunk is the text between `<<<<<<<` and `>>>>>>>`, which is the whole of what has to be decided. With
 * these in the prompt the resolver can edit straight away instead of spending turns reading files to find
 * markers it was already told about.
 */
export function conflictHunks(text: string, maxChars = 4000): string {
  const out: string[] = [];
  const re = /^<<<<<<<[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*$/gm;
  let m: RegExpExecArray | null;
  let used = 0;
  while ((m = re.exec(text)) !== null) {
    const hunk = m[0];
    if (used + hunk.length > maxChars) { out.push("… (further conflicts in this file, not shown)"); break; }
    used += hunk.length;
    out.push(hunk);
  }
  return out.join("\n\n");
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

  /**
   * The conflicted regions, read once and handed over — the resolver should not spend turns finding them.
   *
   * Measured live: a three-file conflict ended with "maximum turn count exceeded (50)", the merge abandoned
   * with the task's review already passed. The same lesson as the reviewers: handed, not hunted.
   */
  const handedHunks = async (files: string[], cwd: string): Promise<string> => {
    const parts: string[] = [];
    for (const f of files.slice(0, 10)) {
      try {
        const text = await readFile(join(cwd, f), "utf8");
        const hunks = conflictHunks(text);
        if (hunks) parts.push(`--- ${f}\n${hunks}`);
      } catch { /* unreadable → the resolver can still open it itself */ }
    }
    return parts.length ? `The conflicted regions:\n\n${parts.join("\n\n")}\n\n` : "";
  };

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
        tools: resolverRegistry(),
        messages: [{ role: "user", content:
          `A git merge left conflicts in the base worktree. Resolve them: for EACH file, remove all conflict ` +
          `markers (<<<<<<<, =======, >>>>>>>) and combine BOTH sides' changes so the intent of each is ` +
          `preserved (don't just pick one side unless the changes are truly incompatible). ` +
          `Conflicted files: ${conflicted.join(", ")}.\n\n${await handedHunks(conflicted, base)}${notes}` }],
        permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
        perAttemptMs: LONG_CALL_MS, // each model in the chain gets its own clock — see RoleAgentOptions
        maxTurns: resolveTurnBudget(conflicted.length),
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
