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
 * Bounds on the sizing call.
 *
 * A ceiling is right here, unlike almost everywhere else in this codebase, because sizing is a BOUNDED
 * question with a safe default: if it does not answer in time, the request takes the pipeline, which is what
 * it would have done anyway. Measured before these existed: a live sizing call had not returned after nine
 * minutes — a gate in front of every pipeline run, costing more than it saves.
 *
 * The turn limit matters as much as the clock. Sizing is "read enough to tell how big this is", not "explore
 * the repository"; on a 45,000-symbol project an unbounded reader will happily do the latter.
 */
export const SIZE_MAX_TURNS = 12;
/**
 * Tuned against a real repository rather than guessed.
 *
 * Measured on a 45,000-symbol project: a sizing that answered correctly took 74 seconds, and a 90-second
 * ceiling timed out two requests out of three — which is safe (they take the pipeline) but is exactly the
 * outcome the sizing exists to avoid. Three minutes is still nothing beside the pipeline it stands in front
 * of, and it is the difference between the gate working and the gate always failing open.
 */
export const SIZE_TOTAL_MS = 180_000;
export const SIZE_ATTEMPT_MS = 90_000;

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
    maxTurns: SIZE_MAX_TURNS,
    perAttemptMs: SIZE_ATTEMPT_MS,
    totalMs: SIZE_TOTAL_MS,
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

/**
 * How much machinery a REQUEST deserves — the same question, asked before a worktree exists.
 *
 * Measured: "ikonu ortala" classified as a feature and bought the whole pipeline — a worktree cut from the
 * branch, a constitution check, a brainstorm WITH the user, a spec, a plan, a task board, waves, a review
 * council, and a pull request. To centre an icon.
 *
 * Binary here, unlike a finding's three depths: the pipeline already contains a brainstorm, so a request that
 * needs one simply belongs in the pipeline.
 */
export interface RequestSize {
  small: boolean;
  /** One sentence — shown when the small path is taken, so the user can see the judgement that was made. */
  reason: string;
  /**
   * For a small change: what must hold when it is done, and the files it touches.
   *
   * Produced HERE because this call already read the code to size it, and because the alternative is an
   * acceptance gate with nothing to check — which passes anything that was attempted.
   */
  acceptance: string[];
  files: string[];
}

export const RequestSizeSchema = z.object({
  small: z.boolean(),
  reason: z.string().describe("One sentence: what about this request makes it small, or what makes it not."),
  acceptance: z.array(z.string()).default([]).describe("If small: what must be true when it is done. One checkable statement each."),
  files: z.array(z.string()).default([]).describe("If small: the repo-relative files it touches."),
});

const SIZE_PROMPT =
  "You size a change request, to decide how much process it deserves. You are not doing the work and you are "
  + "not designing it.\n\n"
  + "Read the code first. The same sentence describes a one-line style change and a rework of a component, "
  + "and only the code says which this is.\n\n"
  + "You are sizing, not implementing: stop as soon as you can tell which side of the line it falls on.\n\n"
  + "SMALL means: the work is already known from the request itself, it is contained to a file or two, and "
  + "there is nothing to decide. Centre an icon. Change a colour. Fix a typo. Rename a label. Correct a "
  + "format string. It goes straight to an implementer, is reviewed, and is checked against your acceptance "
  + "criteria — no spec, no plan, no branch.\n\n"
  + "NOT SMALL means anything else: a new capability, a change whose approach is worth deciding with the "
  + "user, something touching several parts of the system, or anything where you had to guess what was "
  + "wanted. Those get the full pipeline, which exists to work out WHAT to build.\n\n"
  + "When in doubt, say it is not small. A request that is too big for the small path is written and reviewed "
  + "as though it were understood, which is the more expensive mistake.\n\n"
  + "If it IS small, give the acceptance criteria and the files. Those are what the change will be judged "
  + "against, so they must be checkable by looking at the result — not \"the icon looks better\".";

/** Sizes a request before any worktree exists. Never throws: a sizing that fails takes the pipeline. */
export async function sizeRequest(deps: TaskCycleDeps, workdir: string, prompt: string): Promise<RequestSize> {
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(grepTool);
  tools.register(globTool);
  for (const t of contextTools(deps)) tools.register(t);

  const { model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("analyst");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: SIZE_PROMPT,
    tools,
    maxTurns: SIZE_MAX_TURNS,
    perAttemptMs: SIZE_ATTEMPT_MS,
    totalMs: SIZE_TOTAL_MS,
    messages: [{ role: "user", content: `Request: "${prompt}"\n\nSize it.` }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: workdir,
    signal: deps.signal,
  };
  try {
    const r = await runStructuredRole(opts, RequestSizeSchema);
    // A "small" verdict with nothing to check is not usable: the gate would pass anything attempted.
    if (r.small && !r.acceptance.length) return { ...r, small: false, reason: `${r.reason} (no acceptance criteria given)` };
    return r;
  } catch {
    // Including the timeout. Falling through to the pipeline is the same thing that would have happened
    // without sizing at all, so a slow answer costs the wait and nothing else.
    return { small: false, reason: "the request could not be sized in time", acceptance: [], files: [] };
  }
}
