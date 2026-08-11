import type { Card } from "../board/board.js";
import { runToCompletion, type RoleAgentOptions } from "../agent/loop.js";
import { withDeadline } from "../agent/deadline.js";
import { createDefaultRegistry } from "../tools/index.js";
import { buildRememberTool } from "../tools/remember.js";
import { buildSkillTool } from "../skills/apply.js";
import { commitFile } from "./operational.js";
import { memoryHints, reinforceTouched, reinforceUsed } from "./memory-inject.js";
import { routeSkills, filesForTask } from "../skills/route.js";
import { adjudicateSkills } from "../skills/adjudicate.js";
import { placedSkills } from "../prompts.js";
import { loadGraphSync } from "./project-graph.js";
import { constitutionNote } from "./constitution-store.js";
import { applySkills } from "../skills/apply.js";
import { contextTools, projectToolsNote, BATCH_TOOLS_NOTE } from "./task-types.js";
import { handedOver } from "../agent/attach.js";
import type { TaskCycleDeps, RunnableRole } from "./task-types.js";
import { telemetry } from "../obs/telemetry.js";

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
/** How many times a task's budget may be extended. Past this, more time is not what is missing. */
export const MAX_BUDGET_EXTENSIONS = 2;

/**
 * The budget for this attempt: the base, plus one for each deadline death in a row.
 *
 * Counted backwards from the newest event and stopped at the first failure of any OTHER kind — a review
 * rejection means the code was wrong, not that the clock was short, and it should start again from the base.
 */
export function attemptBudget(task: Card, baseMs: number): number {
  let deaths = 0;
  for (let i = task.stageHistory.length - 1; i >= 0 && deaths < MAX_BUDGET_EXTENSIONS; i--) {
    const e = task.stageHistory[i];
    if (e.action === "attempt-error") {
      if (!/budget/i.test(e.note ?? "")) break; // a turn-count or model error is not a shortage of time
      deaths += 1;
      continue;
    }
    if (e.action === "reviewed:fail" || e.action === "acceptance:failed" || e.action === "no-changes") break;
  }
  return baseMs * (1 + deaths);
}

/** How far into the budget the agent is warned. Late enough not to rush it, early enough to land the work. */
export const DEADLINE_WARNING_AT = 0.75;

/**
 * The warning an implementer gets when most of its budget is gone, or undefined while there is time left.
 *
 * A pure function so the wording and the threshold can be asserted without racing a real clock — the
 * behaviour it encodes was measured, not guessed: 22 of 26 attempts died at exactly the deadline, around a
 * hundred turns in, with no notice at all.
 */
export function deadlineWarning(elapsedMs: number, budgetMs: number): string | undefined {
  if (elapsedMs < budgetMs * DEADLINE_WARNING_AT) return undefined;
  const left = Math.max(1, Math.round((budgetMs - elapsedMs) / 60_000));
  return `You have about ${left} minute(s) of budget left for this attempt, and it will be stopped when ` +
    `they are gone. Finish and WRITE what you have now — a partial implementation that is on disk is kept ` +
    `and continued from; work still in your head is lost. Stop exploring.`;
}

/** Runs the implementer role with worktree-scoped tools + a new-vs-returning message. */
/**
 * How much written code the credit pass reads back. Enough to see what a task did; short of re-reading a
 * repository to score a hint.
 */
const MAX_WRITTEN_CHARS = 60_000;

/** What the implementer actually wrote, read back from the files it touched. Never throws. */
async function writtenText(cwd: string, touched: string[]): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const parts: string[] = [];
  let used = 0;
  for (const p of [...new Set(touched)]) {
    if (used >= MAX_WRITTEN_CHARS) break;
    try {
      const t = await readFile(join(cwd, p), "utf8");
      parts.push(t.slice(0, MAX_WRITTEN_CHARS - used));
      used += t.length;
    } catch { /* deleted, or moved on since — it simply contributes nothing */ }
  }
  return parts.join("\n");
}

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
  // …and what it learns on the way, kept for the next agent that opens this area.
  tools.register(buildRememberTool(deps.rememberFact));

  const returning = task.reviewNotes.length > 0;
  /**
   * The task's own brief: what it must deliver, and which files it was planned to touch.
   *
   * The implementer used to be handed the TITLE and nothing else — "This is a NEW task: X. Implement it." —
   * while the card already carried the acceptance criteria it would be judged against and the file list the
   * plan named for it. So every attempt began by rediscovering, from a one-line title, a shape that was
   * written down two stages earlier.
   *
   * It matters because this is where the time goes: measured over one run, implementation was 86% of all
   * slot time (546 minutes against 35 for review), averaging thirteen minutes an attempt, and the commonest
   * way an attempt ended was running out of its budget mid-exploration.
   *
   * The files are a STARTING POINT, not a fence: a plan written before the code cannot know everything the
   * work will touch, and saying otherwise would trade one wrong instruction for another.
   */
  const brief = [
    task.acceptance.length
      ? `It is done when ALL of these are true — they are exactly what the review will check:\n` +
        task.acceptance.map((a) => `- ${a}`).join("\n")
      : "",
    task.files.length
      ? `The plan expects this task to create or change these files:\n${task.files.map((f) => `- ${f}`).join("\n")}\n` +
        `Start there. Touch anything else the work genuinely needs — this is where the plan expected the ` +
        `change to live, not a limit on it.`
      : "",
  ].filter(Boolean).join("\n\n");
  /**
   * What the reviewer will actually be shown.
   *
   * The diff is the deliverable, and an agent's own working files were landing in it: T057 was rejected
   * twice with the reviewer calling the work right — "the payload code itself is approved" — and failing it
   * over three scratch files and a test config narrowed to a single spec. Ten attempts later a task with
   * working code in it was abandoned. Names like `*.tmp.*` are now dropped mechanically; this covers what a
   * pattern cannot, which is a real config edited for the agent's own convenience.
   */
  const hygiene =
    `Your whole diff is what the review judges. Before you finish: undo anything you changed for your OWN ` +
    `convenience — a test config narrowed to one spec, a widened timeout, a disabled lint rule — and delete ` +
    `any scratch, repro or debug file you made. Leaving them in fails the review even when the work is right.`;
  const content = (returning
    ? `This is a RETURNING task: "${task.title}". Address the reviewer notes:\n${task.reviewNotes.map((n) => `- ${n}`).join("\n")}`
    : `This is a NEW task: "${task.title}". Implement it.`) + (brief ? `\n\n${brief}` : "") + `\n\n${hygiene}`;
  // Conventions, gotchas and lessons earlier runs recorded about THIS codebase — the implementer used to be
  // blind to them and kept re-learning the same things.
  const hints = memoryHints(deps, `${task.title} ${task.reviewNotes.join(" ")}`, { role });
  /** Every file this implementer wrote — the evidence for which injected memories it actually used. */
  const touched: string[] = [];
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
    role,
    implementing: true,
    /**
     * The files the PLAN named, when it named any.
     *
     * Inference is a fallback, not the first answer: resolving a task's words against the whole graph returns
     * whatever happens to contain those words, and those paths are then treated as evidence about what kind
     * of work this is. Measured live — "fix product description rendering" resolved to `ShopifyService.cs`,
     * `n11/OrderMapper.cs` and `ExcelTableRenderer.cs`, because marketplace integrators are full of symbols
     * called product and description, and the brainstormer was handed `azure-kubernetes` for it.
     *
     * A card's own file list came from a plan a person approved. It outranks a guess.
     */
    /**
     * Only files someone NAMED, never a guess.
     *
     * Resolving a task's words against the graph was measured over real commit history: on the integration
     * project this runs against, 131 samples, an answer produced for 130 of them, and 9% of those files
     * correct. The domain is the reason: "product", "description", "order" name symbols in every marketplace
     * integrator there is, so the words that describe a task resolve to all of them.
     *
     * Confident and wrong is the worst kind of evidence, because it reads as knowledge. Without it the router
     * falls back to the task's own text, which is honest about knowing less.
     */
    files: task.files,
    placed: placedSkills(),
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
    /**
     * The VERDICT leads, not the skill's name.
     *
     * It used to read "📎 coder · postgresql-optimization — rejected: …", and a user scanning a frontend
     * task saw "coder · postgresql-optimization" and asked, reasonably, why PostgreSQL was involved in it.
     * Nothing was wrong underneath — word overlap proposed a candidate and the adjudicator threw it out with
     * the right reason — but a line that opens with the rejected name reads as a line about that name.
     */
    deps.note?.(`📎 \`${role}\` · **no skill applied** — considered ${routed.map((m) => m.name).join(", ")}: `
      + `${verdict.reasoning ?? "none of them fit this task"}`);
  }
  const withSkills = kept.length
    ? applySkills(resolved.systemPrompt, kept.map((m) => m.name), deps.skillRegistry)
    : resolved.systemPrompt;
  // Registering a tool puts it in the list; it does not make the agent reach for it.
  /**
   * The project's own rules, for the files this card touches.
   *
   * The constitution reached no role's prompt at all until now — it was written, amended, and read by
   * nobody. Handed over by scope rather than whole: 27,529 characters on every call would be most of a
   * prompt spent on rules about code this card does not go near.
   */
  const law = deps.home
    ? await constitutionNote({ ...deps, home: deps.home, note: deps.note }, cwd,
      { role, files: task.files, title: task.title })
    : "";
  const systemPrompt = withSkills + law + projectToolsNote(tools.list(), !!loadGraphSync(cwd)) + BATCH_TOOLS_NOTE;

  // A timeout here is NOT a cancellation: the job is fine, this one attempt ran too long. The two are
  // distinguished below so a genuine Ctrl-C still propagates as a cancellation.
  /**
   * A task that ran out of TIME gets more of it; a task that was rejected does not.
   *
   * The ladder answers every failure the same way — escalate to a stronger role — and for a rejected review
   * that is right. For a deadline it is not: measured on a real board, T035 reached its eleventh attempt with
   * the last SIX all ending "ran past its 20-minute budget", never once judged on its code. A stronger model
   * does not make a twenty-minute job fit in twenty minutes; it just spends more per minute failing to.
   *
   * The evidence is on the card, so the extension is earned rather than guessed: each consecutive
   * deadline death adds one budget, capped, and any other kind of failure resets it to the base.
   */
  const budgetMs = attemptBudget(task, deps.implementerTimeoutMs ?? IMPLEMENTER_TIMEOUT_MS);
  const budget = AbortSignal.timeout(budgetMs);
  /**
   * A warning before the deadline, delivered as a turn-start note.
   *
   * Measured on a real run: 22 of 26 attempts were killed at exactly 20.0 minutes, each around a hundred
   * turns in — the TIME budget always bit first (the 200-turn budget would need forty minutes at twelve
   * seconds a turn), and it arrived without notice. An agent that is told it has minutes left can commit
   * what it has; one that is simply killed leaves the attempt to be redone from nothing.
   *
   * The loop already drains `inbox` at the top of each turn, so this needs no new machinery: the note is
   * handed over once, when most of the budget is gone.
   */
  let warned = false;
  const startedAt = Date.now();
  const deadlineNote = (): string | undefined => {
    if (warned) return undefined; // twice is nagging, and each repetition costs a turn's worth of prompt
    const note = deadlineWarning(Date.now() - startedAt, budgetMs);
    if (note) warned = true;
    return note;
  };
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    ...resolved,
    systemPrompt,
    ...(chain.length ? { model: chain[0], fallbacks: chain.slice(1) } : {}),
    tools,
    maxTurns: IMPLEMENTER_MAX_TURNS,
    /**
     * A screenshot named in the task comes with it.
     *
     * A card built from a small request or from a finding carries the user's own words, and those words can
     * name the picture that shows the problem. Without this the implementer gets a path and the only thing it
     * can do with one is `read_file`, which cannot read a PNG.
     */
    messages: (hints.message ? [{ role: "user" as const, content: hints.message }] : []).concat([
      { role: "user" as const, ...handedOver(content, cwd) },
    ]),
    onUsage: (u) => {
      tok.promptTokens += u.promptTokens;
      tok.completionTokens += u.completionTokens;
      if (u.model && u.model !== serving) { serving = u.model; deps.onProgress?.({ kind: "agent-model", id: task.id, model: serving }); }
      deps.onProgress?.({ kind: "agent-usage", id: task.id, ...tok });
    },
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    // The agent's own inbox first (a by-the-way note), then the deadline warning when it is due.
    inbox: () => deps.inbox?.() ?? deadlineNote(),
    signal: AbortSignal.any([deps.signal, budget]),
    // Stamped with the card id: the agent panel is keyed by it, and unattributed activity goes to the chat.
    onActivity: deps.onActivity ? (a) => deps.onActivity?.({ ...a, agent: task.id }) : undefined,
    /**
     * Attributed by ID, not by title.
     *
     * A wave runs several implementers at once, so unattributed prose interleaves into something no one can
     * read — that much was right. Using the task's TITLE for it was not: one agent narrating fifteen times
     * printed the same forty-word title fifteen times, and the user reported it as the tool "saying the same
     * thing over and over". They were reading it correctly; two thirds of every line WAS the same.
     *
     * The id is unique, it is what the board and the agent panel already show, and it leaves the line to the
     * sentence that differs.
     */
    ...(deps.note ? { onSay: (t: string) => deps.note?.(`  ↳ **${role}** \`${task.id}\` ${t}`) } : {}),
    onLiveActivity: deps.onLiveActivity,
    onWrite: (path) => {
      touched.push(path); // …and remembered, so the memories anchored to this file can be credited below
      return commitFile(deps, cwd, path).then(() => {});
    },
  };
  const mins = Math.round(budgetMs / 60_000);
  const baseMins = Math.round((deps.implementerTimeoutMs ?? IMPLEMENTER_TIMEOUT_MS) / 60_000);
  if (mins > baseMins) {
    deps.note?.(`⏳ **${task.title}** ran out of time, not out of ideas — this attempt gets ${mins} minutes.`);
  }
  // Surfaced as a failed ATTEMPT (the escalation ladder catches it and moves up a tier), with a note that
  // says what happened so the next tier does not simply repeat it.
  const overran = `the implementer ran past its ${mins}-minute budget for a single attempt and was stopped. ` +
    `Whatever it wrote is committed and kept — continue from there rather than starting over.`;
  try {
    /**
     * The budget is enforced HERE, not only inside the loop.
     *
     * The loop tests its signal at the top of each turn, which bounds turns rather than time: one turn is a
     * model response plus every tool call it asked for, and a shell command runs for minutes. A task was seen
     * still held at 26 minutes on a 20-minute budget — the abort had fired, the loop had not come back round.
     * The attempt now ends when the budget does; the loop unwinds behind it on the same signal.
     */
    const attempt = (): Promise<unknown> => withDeadline(runToCompletion(opts), budget, overran);
    const timed = (): Promise<unknown> => deps.timings ? deps.timings.time("implementation", attempt) : attempt();
    // Everything this implementer does — its model calls, its tool calls — hangs off this span.
    await telemetry().span("stage.implementation", {
      "hc.stage": "implementation",
      "hc.role": role,
      "hc.task.id": task.id,
      "hc.task.title": task.title.slice(0, 120),
      "hc.model": chain[0],
      "hc.attempt": task.attempts,
    }, timed);
  } catch (e) {
    if (deps.signal.aborted || !budget.aborted) throw e; // a real cancel, or a real error → unchanged
    throw new Error(overran);
  } finally {
    // In `finally` because a failed attempt still consumed the memory: an implementer that ran out of time
    // in the right file was helped by the hint that sent it there, and crediting only the attempts that
    // succeed would score memories on the model's luck rather than on their own usefulness.
    reinforceTouched(deps, hints.ids, touched, role);
    /**
     * …and by what it WROTE, because the file anchor can only reach a ninth of the store.
     *
     * `reinforceTouched` credits a memory when the implementer went to the file that memory is anchored to.
     * Measured on the real store: 721 selectable memories, 470 with any anchor, and only 67 — 9% — with a
     * FILE anchor. So eleven memories in twelve are outside what that path can ever credit, whatever they
     * contributed. It showed as `coder`: 155 injections, 1 use, beside judges at 92%.
     *
     * The code an implementer writes is its artefact the way a verdict is a judge's, so it is read the same
     * way: a memory whose words turn up in what was written was used.
     */
    reinforceUsed(deps, hints.ids, await writtenText(cwd, touched), role);
  }
}
