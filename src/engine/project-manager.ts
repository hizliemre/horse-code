import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { Board } from "../board/board.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  deps: z.array(z.string()),
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
  for (const t of tasks) board.addCard({ id: t.id, title: t.title, deps: t.deps });
  return board;
}
