import { respondIn } from "../engine/language.js";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { runToCompletion } from "../agent/loop.js";
import { attachedImages } from "../agent/attach.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { contextTools, projectToolsNote, BATCH_TOOLS_NOTE } from "../engine/task-types.js";
import { routeSkills, filesForTask } from "../skills/route.js";
import { applySkills } from "../skills/apply.js";
import { placedSkills } from "../prompts.js";
import { loadGraphSync } from "../engine/project-graph.js";
import { writerRegistry, buildAskUserTool } from "../engine/writer-registry.js";
import { commitFile } from "../engine/operational.js";
import { normalizeQuestion } from "../engine/normalize-question.js";
import { memoryHints } from "../engine/memory-inject.js";
import type { TaskCycleDeps } from "../engine/task-types.js";
import type { AskUser } from "../engine/review.js";
import type { SpecKitTemplates } from "./templates.js";
import type { FeaturePaths } from "./layout.js";
import { constitutionPath } from "./layout.js";

export interface PhaseDeps { deps: TaskCycleDeps; templates: SpecKitTemplates; workdir: string; askUser: AskUser }

// Common framing: spec-kit command prompts assume bash scaffolding scripts; horse-code already scaffolds
// the workspace, so the role must skip those and just write the target file with write_file.
const SKIP = "The workspace is already scaffolded — do NOT run any shell scripts. Use write_file to write the output file exactly at the path given below.";

// Authoring a spec/plan (and revising it across review rounds) legitimately needs far more tool-round turns
// than the 50-turn default meant for short agents — a big doc with clarify Q&A + several revise passes can
// exceed 50 read/edit turns in one invocation. Give the spec-kit phases a generous ceiling so a healthy phase
// isn't cut off mid-write (which would crash the whole upstream); a genuinely stuck phase still stops here.
const PHASE_MAX_TURNS = 200;

/**
 * The brainstormer drives itself from its role prompt rather than a spec-kit command — spec-kit has no
 * brainstorm step, and inventing one in template form would just restate the role prompt.
 */
const BRAINSTORM_COMMAND =
  "You are the brainstormer. Produce a decided design brief for the request below, then write it to the file " +
  "named in the message. Explore the repo before proposing anything, ask only questions that change the " +
  "design, and have the user choose between real alternatives.";

async function runRole(
  p: PhaseDeps, role: string, command: string, message: string, extraTools = false,
  /** What the routing should read: the user's request, when the caller has it. */
  subject?: string,
): Promise<void> {
  // fallbackOpts (not resolve): spec-kit phases drive the role with the spec-kit command prompt, so they
  // supply their own prompt — but still want the role's model CHAIN + session-fallback on exhaustion.
  const { model, fallbacks, onExhausted, onFallback } = p.deps.roleRegistry.fallbackOpts(role);
  const tools = writerRegistry(p.deps.skillRegistry, [
    ...(extraTools ? [buildAskUserTool(p.askUser, (q) => normalizeQuestion(p.deps, q))] : []),
    ...contextTools(p.deps), // the spec and the plan are written about a codebase — let them see it
  ]);
  const hints = memoryHints(p.deps, message, { role });
  /**
   * Skills this stage's subject needs.
   *
   * Wired here as well as at implementation because this is the stage that can ASK. A design skill whose
   * flow begins by interviewing the user for a product brief can only run that interview where `ask_user`
   * exists — which is here, not in a wave of parallel implementers that must not block on a human.
   */
  /**
   * Routed on the REQUEST, not on the whole phase message, and with no guessed files.
   *
   * The message is mostly ours: a spec template, a command prompt, instructions about where to write. Feeding
   * that to the router is feeding it our own boilerplate — and asking a 46,901-symbol graph which files the
   * boilerplate is "about" produced eight marketplace integrators for a request about rendering a
   * description, whose paths then read as infrastructure work.
   *
   * At this stage nothing is known about which files the work touches; that is what the spec and the plan are
   * for. Guessing it in order to route a skill is inventing evidence.
   */
  const routed = routeSkills(subject ?? message, p.deps.skillRegistry, [], { role, placed: placedSkills() });
  if (routed.length) p.deps.note?.(`📎 \`${role}\` · ${routed.map((m) => `**${m.name}**`).join(", ")}`);
  const opts: RoleAgentOptions = {
    provider: p.deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: (routed.length
      ? applySkills(`${command}\n\n${SKIP}${p.deps.roleRegistry.ruleSuffix()}`, routed.map((m) => m.name), p.deps.skillRegistry)
      : `${command}\n\n${SKIP}${p.deps.roleRegistry.ruleSuffix()}`) + projectToolsNote(tools.list(), !!loadGraphSync(p.workdir)) + BATCH_TOOLS_NOTE,
    tools,
    maxTurns: PHASE_MAX_TURNS,
    // Project memory (conventions/decisions/lessons) reaches the authoring roles too, not just the coach.
    /**
     * A screenshot named in the request comes with it, here as everywhere else.
     *
     * Measured from a live run: the request carried the path of a pasted screenshot, no image was attached,
     * and the analyst did the only thing left to it — `read_file` on a PNG, which cannot read one. The
     * evidence the user handed over never reached the model that needed it.
     */
    messages: (hints.message ? [{ role: "user" as const, content: hints.message }] : []).concat([
      { role: "user" as const, content: message, ...(() => {
        const images = attachedImages(message, p.workdir);
        return images.length ? { images } : {};
      })() },
    ]),
    permission: p.deps.permission,
    approve: p.deps.approve,
    cwd: p.workdir,
    signal: p.deps.signal,
    onActivity: p.deps.onActivity,
    onLiveActivity: p.deps.onLiveActivity,
    onWrite: (path) => commitFile(p.deps, p.workdir, path).then(() => {}), // per-write conventional commit
    /**
     * A phase can be interrupted with a correction.
     *
     * These are the longest interactive stretches in the tool — writing a constitution, a spec, a plan — and
     * they were the only ones a mid-run note could not reach. "Actually, keep it to one page" arriving four
     * minutes in is worth more than the same sentence after the document is finished and reviewed.
     */
    inbox: p.deps.inbox,
    /**
     * What the role says reaches the user.
     *
     * A phase used to show tool cards and an artefact and nothing else. Reported twice in the same shape:
     * the analyst offered "I'll show you the skeleton first and wait for approval", the user chose it, the
     * analyst wrote the skeleton — and asked "do you approve the skeleton above?" with nothing above it.
     * The model did exactly what it promised; the words were thrown away.
     */
    ...(p.deps.note ? { onSay: p.deps.note } : {}),
  };
  await runToCompletion(opts);
}

/**
 * Establish a constitution, or AMEND the one that is already there.
 *
 * The message used to be the same either way, and it never carried the request. Its whole content was
 * "Establish the project constitution", the blank template, and where to write it — so the sentence the user
 * typed reached nobody. Measured live on "make all agent replies to the user Turkish": the analyst read the
 * existing 543-line document twelve times, globbed for `**\/speckit*`, grepped for placeholder tokens, and
 * then said so itself — "There is nothing to fill in and no conflict to reconcile. So the useful question is
 * what you actually want changed" — before asking the user what they wanted. It was not wandering. It had
 * not been told.
 *
 * A document that exists is amended: smallest change that satisfies the request, version bumped, done. The
 * template and its placeholder ceremony belong to the case it was written for — a project that has none.
 */
export async function runConstitution(p: PhaseDeps, request?: string, language?: string): Promise<void> {
  const rel = relative(p.workdir, constitutionPath(p.workdir));
  const asked = request?.trim()
    ? `What the user asked for:\n"${request.trim()}"\n\n`
    : "";
  const exists = existsSync(constitutionPath(p.workdir));
  const msg = exists
    ? `${asked}The project already has a constitution at "${rel}". AMEND it: make the smallest change that `
      + `satisfies the request, in the document's own language and style, and leave everything else exactly `
      + `as it is. Bump the version and its amendment record the way the document itself prescribes. Do not `
      + `reshape it to a template, do not re-derive principles it already ratified, and do not ask what to `
      + `change when the request already says. If the request genuinely cannot be expressed as an amendment, `
      + `say why in one sentence and stop.`
    : `${asked}Establish the project constitution. Ask the user about core principles with ask_user if needed.\n`
      + `Follow this template:\n\n${p.templates.template("constitution")}\n\nWrite it to "${rel}".`;
  // It asks the user about principles and reports back — see src/engine/language.ts.
  await runRole(p, "analyst", p.templates.command("constitution"), msg + respondIn(language), true, request);
}

/**
 * Brainstorm: turn the raw request into a DECIDED design before any spec exists.
 *
 * The spec used to be written straight from the request, so the first real design decision was made
 * implicitly, by whoever authored the spec, and only surfaced in review — where it is expensive to revisit.
 * This makes the decision explicit and the user's, once, up front. Interaction is deliberate here: the
 * autonomy the pipeline needs starts AFTER the work is decided.
 */
export async function runBrainstorm(p: PhaseDeps, paths: FeaturePaths, prompt: string): Promise<void> {
  const rel = relative(p.workdir, paths.brainstorm);
  const msg =
    `Request: "${prompt}".\n\n` +
    `Explore this repository first, then decide the approach WITH the user, then write the decision to "${rel}".`;
  await runRole(p, "brainstormer", BRAINSTORM_COMMAND, msg, true, prompt);
}

/**
 * What the analyst is told, given whether a design brief actually exists.
 *
 * Separated out because the two facts had drifted apart: the brief is OPTIONAL in the pipeline — a brainstorm
 * that failed to write one is explicitly allowed to continue — while this prompt made it mandatory. Measured
 * from a live run, the analyst refused exactly as instructed ("Since you specified that the spec must honor
 * the decisions in that file, I need the file to proceed") and the run died with "specify did not produce
 * spec.md".
 *
 * The absence is stated rather than left silent: an analyst told nothing about a missing brief will look for
 * one anyway, which is what the whole search in that run was.
 */
export function specifyMessage(
  prompt: string, specRel: string, briefRel: string, hasBrief: boolean, template: string, feedback?: string[],
): string {
  if (feedback?.length) {
    return `Revise the spec at "${specRel}" with these reviewer notes:\n`
      + `${feedback.map((f) => `- ${f}`).join("\n")}\nOriginal request: ${prompt}`;
  }
  // The design was already decided WITH the user in the brainstorm; the spec states what that design must
  // deliver, it does not re-open the choice.
  const source = hasBrief
    ? `Read "${briefRel}" FIRST — the approach was already decided with the user there, and the spec must `
      + `honor it (do not re-litigate the choice or reintroduce a rejected alternative).\n`
    : `There is no design brief for this work — none was written, and there is nothing to look for. Work from `
      + `the request itself and from the code, and decide what the spec needs by reading the repository.\n`;
  return `Feature request: "${prompt}". ${source}`
    + `Ask clarifying questions with ask_user only if strictly necessary.\n`
    + `Follow this template:\n\n${template}\n\nWrite the spec to "${specRel}".`;
}

export async function runSpecify(p: PhaseDeps, paths: FeaturePaths, prompt: string, feedback?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.spec);
  const brief = relative(p.workdir, paths.brainstorm);
  const msg = specifyMessage(prompt, rel, brief, existsSync(paths.brainstorm), p.templates.template("spec"), feedback);
  await runRole(p, "analyst", p.templates.command("specify"), msg, true, prompt);
}

export async function runPlan(p: PhaseDeps, paths: FeaturePaths, feedback?: string[], carryOver?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.plan);
  const specRel = relative(p.workdir, paths.spec);
  const cRel = relative(p.workdir, constitutionPath(p.workdir));
  // Non-blocking notes the spec review deliberately deferred rather than spending another revision round on:
  // surfaced here so the plan can settle them where they actually belong, instead of being lost.
  const carried = carryOver?.length
    ? `\n\nKnown non-blocking notes carried over from the spec review — address them in the plan where they ` +
      `apply (they are context, not blockers):\n${carryOver.map((c) => `- ${c}`).join("\n")}`
    : "";
  const msg = feedback?.length
    ? `Revise the plan at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}`
    : `Read the spec "${specRel}" and the constitution "${cRel}" (if present).\n` +
      `Follow this template:\n\n${p.templates.template("plan")}\n\nWrite the plan to "${rel}".${carried}`;
  await runRole(p, "planner", p.templates.command("plan"), msg);
}

/**
 * What the project manager is told, given a template written for a different situation.
 *
 * spec-kit's tasks template is for a project being CREATED: its phases are Setup ("Configure linting and
 * formatting tools"), Foundational ("Create base models/entities that all stories depend on"), one per user
 * story, and Polish ("Documentation updates", "Code cleanup", "Run quickstart.md validation"). Its examples
 * split by entity — "Create Entity1 model", "Create Entity2 model".
 *
 * Handed that and a one-line rendering fix in an existing repository, the planner produced exactly that
 * shape: 27 cards, of which three verified the workspace and the lint config, five split one file by symbol,
 * and the tail was lint, format, build and "Run quickstart.md validation" — which is in the template word for
 * word. It was not being careless. It was being faithful to a template about a different situation.
 *
 * The template's FORMAT is what is wanted here. Its premise is not, and saying so is cheaper than fighting
 * its examples one rule at a time.
 */
export function tasksMessage(planRel: string, tasksRel: string, template: string, carryOver: string[] = []): string {
  const carried = carryOver.length
    ? `\n\nKnown non-blocking notes carried over from the earlier reviews — fold them into a task only where `
      + `they genuinely apply (they are context, not new requirements):\n${carryOver.map((c) => `- ${c}`).join("\n")}`
    : "";
  return `Read the plan "${planRel}" and break it into an actionable task list.\n`
    + `This codebase ALREADY EXISTS. The template below is written for a project being created from scratch, `
    + `so its Setup and Foundational phases describe work that was done years ago here, and its Polish phase `
    + `lists things that are not tasks. Take the template's FORMAT — ids, [P] markers, file paths, phases — `
    + `and let the plan decide what is actually in it.\n`
    /**
     * Measured on a live run: one request became 27 cards whose first three were "Verify and anchor Nx
     * workspace environment", "Inspect existing dependencies" and "Verify linting config files". Each bought
     * an implementer, a code review and an acceptance gate, and each ended with the repository unchanged.
     */
    + `Every task must leave the repository DIFFERENT — code, a test, a document. Looking at something is not `
    + `a task: an implementer reads the code, checks the versions and finds its way around as part of doing `
    + `the work, so "verify X", "inspect Y", "confirm Z" belong inside the task that needs the answer, not `
    + `beside it. If the only thing a task would deliver is knowing something, it is not on the list.\n`
    + `Nor is running a command: linting, formatting, building and typechecking are how a task is known to be `
    + `FINISHED. Put them in the acceptance criteria of the tasks that changed the code — the implementer runs `
    + `them there anyway — instead of giving each one a task of its own.\n`
    /**
     * Same board: five cards wrote nothing but `safe-html.pipe.ts`, four nothing but its spec, three nothing
     * but one template. Cards on one file cannot run in parallel, so each extra one is another implementer,
     * code review and acceptance gate in a queue for one coherent change.
     */
    + `And one file is usually one task. Tasks that write the same file cannot run at the same time, so `
    + `splitting a single file across several of them buys nothing and pays for a full implement-and-review `
    + `round each time. Split by what is genuinely independent, not by what is separately describable — the `
    + `template's "one entity per task" examples are about creating new files, not changing existing ones.\n`
    + `Follow this template:\n\n${template}\n\nWrite the tasks to "${tasksRel}".${carried}`;
}

export async function runTasks(p: PhaseDeps, paths: FeaturePaths, carryOver?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.tasks);
  const planRel = relative(p.workdir, paths.plan);
  const msg = tasksMessage(planRel, rel, p.templates.template("tasks"), carryOver ?? []);
  await runRole(p, "project-manager", p.templates.command("tasks"), msg);
}
