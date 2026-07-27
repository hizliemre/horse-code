import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { Board } from "../board/board.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  deps: z.array(z.string()),
  /**
   * Acceptance criteria: what must be OBSERVABLY true when this task is done — each one checkable against the
   * worktree (a file exists and exports X, a command succeeds, a behavior is covered by a test). Without them
   * "done" is whatever the implementer says it is; with them, completion is verified rather than asserted.
   */
  acceptance: z.array(z.string()).default([]),
  /**
   * The files this task is expected to create or modify, repo-relative.
   *
   * The task list already names them, and until now they stopped there. Wave planning needs them: two tasks
   * that write the same file are not independent whichever way their `deps` read, and that is not something
   * `deps` alone can be trusted to say — a missed dependency does not fail loudly, it surfaces hours later
   * as a merge conflict.
   */
  files: z.array(z.string()).default([]),
});

// Note: superRefine validates dep INTEGRITY (duplicate id, dangling dep); ACYCLICITY is not
// enforced here — dependency cycles are caught downstream by computeWaves (team-lead).
export const TasksSchema = z
  .object({ tasks: z.array(taskSchema) })
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (const t of val.tasks) {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", message: `duplicate task id: ${t.id}` });
      ids.add(t.id);
    }
    for (const t of val.tasks) {
      for (const d of t.deps) {
        if (!ids.has(d)) {
          ctx.addIssue({ code: "custom", message: `task ${t.id}: undefined dependency: ${d}` });
        }
      }
    }
  });

/** Plan (in opts.messages) → a Board with task cards. Dep integrity self-corrects via submit-retry. */
export async function runProjectManager(opts: RoleAgentOptions): Promise<Board> {
  const { tasks } = await runStructuredRole(opts, TasksSchema);
  const board = new Board();
  for (const t of tasks) board.addCard({ id: t.id, title: t.title, deps: t.deps, acceptance: t.acceptance, files: t.files });
  return board;
}
