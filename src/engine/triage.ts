import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { contextTools } from "./task-types.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { Finding } from "./finding.js";

/**
 * How much machinery a finding deserves.
 *
 * The same shape as `routeIntent`, one level down, and for the same reason: the model decides WHAT the work
 * is, and what that costs is not a judgement call. A finding whose fix is obvious must not buy a spec and a
 * plan; a finding that turns out to be a redesign must not be answered with one card and a hopeful commit.
 *
 * Three depths, because there are three genuinely different situations:
 *
 * - `task` — the work is known. Write it, review it, check it against what was asked. No design step,
 *   because there is nothing to decide.
 * - `brainstorm` — the fix is not obvious, or there is more than one way and they differ for the user.
 *   The approach is decided WITH them before anything is written.
 * - `full` — this is not a fix, it is a piece of work that was discovered during testing. It gets what any
 *   piece of work gets: a spec, a plan, tasks.
 */
export type FixDepth = "task" | "brainstorm" | "full";

export interface Triage {
  depth: FixDepth;
  /** Why, in one sentence — shown to the user whenever the depth is more than a task. */
  reason: string;
}

export const TriageSchema = z.object({
  depth: z.enum(["task", "brainstorm", "full"]),
  reason: z.string().describe("One sentence: what about this finding puts it at that depth."),
});

const PROMPT =
  "You size a defect found during manual testing, to decide how much process it deserves. You are not fixing "
  + "it and you are not designing the fix.\n\n"
  + "Read the code before you answer — the same words describe a one-line label fix and a rework of how a "
  + "screen gets its data, and only the code says which this is.\n\n"
  + "`task`: the change is known and contained. A wrong label, a missing field on a screen that already has "
  + "the data, a formatting bug, a validation that is checking the wrong thing. Most findings are this.\n\n"
  + "`brainstorm`: the fix is not obvious, or there is more than one reasonable way and they differ in a way "
  + "the user would care about. Decide WITH them rather than guessing.\n\n"
  + "`full`: this is not a fix. It is a piece of work that testing happened to discover — a capability that "
  + "was never built, a design that does not hold, something that touches several parts of the system.\n\n"
  + "Prefer the smallest depth the evidence supports. Buying a spec for a label is waste; but a `task` that "
  + "turns out to be a redesign is worse, because it is written and reviewed as if it were understood.";

/** Sizes one finding. Never throws: a triage that cannot run is not a reason to lose the finding. */
export async function triageFinding(deps: TaskCycleDeps, workdir: string, f: Finding): Promise<Triage> {
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(grepTool);
  tools.register(globTool);
  for (const t of contextTools(deps)) tools.register(t);

  const { model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("analyst");
  const message =
    `A defect was found while manually testing existing work.\n\n`
    + `Title: ${f.title}\n\nWhat was seen:\n${f.detail}\n`
    + (f.files.length ? `\nFiles it appears to involve:\n${f.files.map((x) => `- ${x}`).join("\n")}\n` : "")
    + (f.acceptance.length ? `\nWhat must be true for it to be settled:\n${f.acceptance.map((x) => `- ${x}`).join("\n")}\n` : "")
    + `\nSize it.`;

  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: PROMPT,
    tools,
    maxTurns: 30,
    messages: [{ role: "user", content: message }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: workdir,
    signal: deps.signal,
  };
  try {
    return await runStructuredRole(opts, TriageSchema);
  } catch {
    /**
     * A triage that could not run sizes it as a task.
     *
     * Not because that is likely right, but because it is the depth the user is present for: the fix happens
     * in front of them, they see the change and re-run the scenario. Defaulting UP would start a spec and a
     * plan on the strength of a call that failed.
     */
    return { depth: "task", reason: "the triage could not run; treated as a contained change" };
  }
}

/** What the user is asked when the depth is more than a card. */
export function describeEscalation(f: Finding, t: Triage): string {
  const what = t.depth === "brainstorm"
    ? "decide the approach with you first, then implement it"
    : "write a spec and a plan for it, then break it into tasks";
  return `**${f.title}**\n\nThis is bigger than a single fix — ${t.reason}\n\nI would ${what}.`;
}
