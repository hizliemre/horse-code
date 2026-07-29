import { z } from "zod";
import type { Card } from "../board/board.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";
import type { TaskCycleDeps, ImplementerRole } from "./task-types.js";
import { routeByEvidence } from "./route-role.js";
import { telemetry } from "../obs/telemetry.js";
import { callSignal, SHORT_CALL_MS } from "../agent/deadline.js";

const RouteSchema = z.object({ role: z.enum(["coder", "designer"]) });

/**
 * Picks the implementer role. Evidence first; the model only for the tasks it does not settle.
 *
 * On failure → "coder"; signal.aborted → throws.
 */
export async function routeTask(deps: TaskCycleDeps, task: Card): Promise<ImplementerRole> {
  const evidence = routeByEvidence(task);
  telemetry().event("decision.route", {
    "hc.decision": "route",
    "hc.task.id": task.id,
    "hc.role": evidence.role,
    "hc.route.why": evidence.why,
    "hc.route.by": evidence.role ? "evidence" : "model",
  });
  if (evidence.role) return evidence.role;
  try {
    const resolved = deps.roleRegistry.resolve("router");
    const tools = new ToolRegistry();
    tools.register(buildSkillTool(deps.skillRegistry));
    const opts: RoleAgentOptions = {
      provider: deps.provider,
      ...resolved,
      tools,
      messages: [
        { role: "user", content:
          `Task: "${task.title}"\n` +
          (task.files.length ? `Files it writes: ${task.files.join(", ")}\n` : "") +
          (task.acceptance.length ? `Done when: ${task.acceptance.join("; ")}\n` : "") +
          `\nIs this UI/UX work (designer) or code work (coder)? Judge by what the work IS, not by the file ` +
          `types: a component file holding a data hook is code work, and a component file whose whole job is ` +
          `how the thing looks is design work.` },
      ],
      permission: deps.permission,
      approve: deps.approve,
      cwd: "/",
      signal: deps.signal,
    perAttemptMs: SHORT_CALL_MS, // each model in the chain gets its own clock — see RoleAgentOptions
      // One question, one answer, from the text in front of it. Nothing here is worth a fifty-turn budget —
      // and an unbounded structured role walks its entire fallback chain when a model will not submit.
      maxTurns: 3,
    };
    const { role } = await runStructuredRole(opts, RouteSchema);
    return role;
  } catch (e) {
    if (deps.signal.aborted) throw e;
    return "coder";
  }
}
