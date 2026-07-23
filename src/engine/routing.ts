import { z } from "zod";
import type { Card } from "../board/board.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, ImplementerRole } from "./task-types.js";

const RouteSchema = z.object({ role: z.enum(["coder", "designer"]) });

/** Picks the implementer role from the task title. On failure → "coder"; signal.aborted → throws. */
export async function routeTask(deps: TaskCycleDeps, task: Card): Promise<ImplementerRole> {
  try {
    const resolved = deps.roleRegistry.resolve("router");
    const tools = new ToolRegistry();
    tools.register(buildSkillTool(deps.skillRegistry));
    const opts: RoleAgentOptions = {
      provider: deps.provider,
      ...resolved,
      tools,
      messages: [
        { role: "user", content: `Task: "${task.title}". Is this UI/UX work (designer) or code work (coder)?` },
      ],
      permission: deps.permission,
      approve: deps.approve,
      cwd: "/",
      signal: deps.signal,
    };
    const { role } = await runStructuredRole(opts, RouteSchema);
    return role;
  } catch (e) {
    if (deps.signal.aborted) throw e;
    return "coder";
  }
}
