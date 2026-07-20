import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { Board } from "../board/board.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  deps: z.array(z.string()),
});

// Not: superRefine dep-BÜTÜNLÜĞÜNÜ doğrular (tekrarlı id, dangling dep); ASİKLİKLİK burada
// zorlanmaz — bağımlılık döngüleri downstream'de computeWaves (team-lead) tarafından yakalanır.
export const TasksSchema = z
  .object({ tasks: z.array(taskSchema) })
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (const t of val.tasks) {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", message: `tekrarlı task id: ${t.id}` });
      ids.add(t.id);
    }
    for (const t of val.tasks) {
      for (const d of t.deps) {
        if (!ids.has(d)) {
          ctx.addIssue({ code: "custom", message: `task ${t.id}: tanımsız bağımlılık: ${d}` });
        }
      }
    }
  });

/** Plan (opts.messages'te) → task kartlı bir Board. Dep-bütünlüğü submit-retry ile self-correct. */
export async function runProjectManager(opts: RoleAgentOptions): Promise<Board> {
  const { tasks } = await runStructuredRole(opts, TasksSchema);
  const board = new Board();
  for (const t of tasks) board.addCard({ id: t.id, title: t.title, deps: t.deps });
  return board;
}
