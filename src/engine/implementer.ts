import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildSkillTool } from "../skills/apply.js";
import { commitFile } from "./operational.js";
import { memoryHints } from "./memory-inject.js";
import { routeSkills, filesForTask } from "../skills/route.js";
import { adjudicateSkills } from "../skills/adjudicate.js";
import { placedSkills } from "../prompts.js";
import { loadGraphSync } from "./project-graph.js";
import { applySkills } from "../skills/apply.js";
import { contextTools, projectToolsNote } from "./task-types.js";
import type { TaskCycleDeps, RunnableRole } from "./task-types.js";

// A real coding task (scaffold a project, write code + tests, iterate until green) legitimately needs far
// more turns than the 50-turn default meant for short role agents. Give the implementer a generous budget so
// a large-but-healthy task isn't cut off mid-work; a genuinely stuck task still hits this ceiling and, thanks
// to per-task error isolation in runWaveTask, fails ONLY that task instead of crashing the whole job.
const IMPLEMENTER_MAX_TURNS = 200;

/**
 * Wall-clock ceiling for ONE implementation attempt.
 *
 * The turn budget alone does not bound time: a task was observed running for 378 minutes — over six hours on a
 * single card — because nothing said when to stop. Generous enough that a real scaffold-and-test task finishes
 * comfortably, small enough that a stuck one hands over to the next tier the same day.
 *
 * Nothing written is lost when it fires: every write is committed to the task worktree as it happens, so the
 * partial work stays and the next tier continues from it.
 */
export const IMPLEMENTER_TIMEOUT_MS = 20 * 60 * 1000;

/** Runs the implementer role with worktree-scoped tools + a new-vs-returning message. */
export async function runImplementer(
  deps: TaskCycleDeps,
  role: RunnableRole,
  task: Card,
  cwd: string,
  /** Position among the workers running this SAME role in parallel → each leads with a different chain link. */
  slot = 0,
): Promise<void> {
  const resolved = deps.roleRegistry.resolve(role);
  const chain = deps.roleRegistry.chainFor(role, slot);
  // Per-agent metering, exactly as the review lenses do it — the live row shows what this worker is spending
  // WHILE it spends it, and renames itself if its chain slides to another model.
  const tok = { promptTokens: 0, completionTokens: 0 };
  let serving = chain[0] ?? "";
  const tools = createDefaultRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  // Project knowledge (e.g. a code-graph server): what calls this, what a change here can reach. Without it
  // the implementer edits a file with no idea what depends on it.
  for (const t of contextTools(deps)) tools.register(t);

  const returning = task.reviewNotes.length > 0;
  const content = returning
    ? `This is a RETURNING task: "${task.title}". Address the reviewer notes:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `This is a NEW task: "${task.title}". Implement it.`;
  // Conventions, gotchas and lessons earlier runs recorded about THIS codebase — the implementer used to be
  // blind to them and kept re-learning the same things.
  const hints = memoryHints(deps, `${task.title} ${task.reviewNotes.join(" ")}`, { role });
  /**
   * Skills this particular task needs, matched from what it asks for.
   *
   * A discoverable skill only helps if the agent notices it and fetches it, which is a coin toss; attaching it
   * to the role instead puts it in every prompt including the tasks it has nothing to say about. Matching the
   * task against each skill's own "use when…" description resolves both: a UI task gets the design skill
   * inlined, a queue-migration task does not.
   */
  const attached = deps.roleRegistry.skillsFor(role);
  const subject = `${task.title} ${task.acceptance.join(" ")} ${task.reviewNotes.join(" ")}`;
  const routed = routeSkills(subject, deps.skillRegistry, attached, {
    role, implementing: true, files: filesForTask(subject, loadGraphSync(cwd)), placed: placedSkills(),
  });
  // Only the borderline matches are adjudicated; the confident ones are already right and paying for a
  // verdict on them would be paying for an answer we have.
  const verdict = routed.length
    ? await adjudicateSkills({
        provider: deps.provider, model: chain[0] ?? "", task: subject,
        matches: routed, registry: deps.skillRegistry, signal: deps.signal,
      })
    : { keep: routed, asked: false, reasoning: undefined as string | undefined };
  const kept = verdict.keep;
  if (kept.length) {
    deps.note?.(`📎 \`${role}\` · ${kept.map((m) => `**${m.name}**`).join(", ")}${verdict.asked ? " _(adjudicated)_" : ""}`);
  } else if (routed.length && verdict.asked) {
    deps.note?.(`📎 \`${role}\` · ${routed.map((m) => m.name).join(", ")} — rejected: ${verdict.reasoning ?? "does not apply"}`);
  }
  const withSkills = kept.length
    ? applySkills(resolved.systemPrompt, kept.map((m) => m.name), deps.skillRegistry)
    : resolved.systemPrompt;
  // Registering a tool puts it in the list; it does not make the agent reach for it.
  const systemPrompt = withSkills + projectToolsNote(tools.list(), !!loadGraphSync(cwd));

  // A timeout here is NOT a cancellation: the job is fine, this one attempt ran too long. The two are
  // distinguished below so a genuine Ctrl-C still propagates as a cancellation.
  const budget = AbortSignal.timeout(deps.implementerTimeoutMs ?? IMPLEMENTER_TIMEOUT_MS);
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    systemPrompt,
    ...(chain.length ? { model: chain[0], fallbacks: chain.slice(1) } : {}),
    tools,
    maxTurns: IMPLEMENTER_MAX_TURNS,
    messages: hints.message ? [{ role: "user", content: hints.message }, { role: "user", content }] : [{ role: "user", content }],
    onUsage: (u) => {
      tok.promptTokens += u.promptTokens;
      tok.completionTokens += u.completionTokens;
      if (u.model && u.model !== serving) { serving = u.model; deps.onProgress?.({ kind: "agent-model", id: task.id, model: serving }); }
      deps.onProgress?.({ kind: "agent-usage", id: task.id, ...tok });
    },
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: AbortSignal.any([deps.signal, budget]),
    // Stamped with the card id: the agent panel is keyed by it, and unattributed activity goes to the chat.
    onActivity: deps.onActivity ? (a) => deps.onActivity?.({ ...a, agent: task.id }) : undefined,
    onLiveActivity: deps.onLiveActivity,
    onWrite: (path) => commitFile(deps, cwd, path).then(() => {}), // per-write conventional commit in the task worktree
  };
  try {
    await runToCompletion(opts);
  } catch (e) {
    if (deps.signal.aborted || !budget.aborted) throw e; // a real cancel, or a real error → unchanged
    // Surfaced as a failed ATTEMPT (the escalation ladder catches it and moves up a tier), with a note that
    // says what happened so the next tier does not simply repeat it.
    const mins = Math.round((deps.implementerTimeoutMs ?? IMPLEMENTER_TIMEOUT_MS) / 60_000);
    throw new Error(`the implementer ran past its ${mins}-minute budget for a single attempt and was stopped. Whatever it wrote is committed and kept — continue from there rather than starting over.`);
  }
}
