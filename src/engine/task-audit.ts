import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import type { Board, Card } from "../board/board.js";

/**
 * The one stage of the pipeline nothing checked.
 *
 * A spec and a plan each go through fifteen lenses, a council and a judge. The task breakdown — which every
 * hour of implementation after it is spent executing — went straight from the model to the board. A bad
 * breakdown is not a failure anyone sees: the tasks all pass their reviews, and the wrong work is delivered
 * correctly.
 *
 * Two layers, in that order. Most of what goes wrong is structural and costs nothing to find — an empty
 * acceptance list, a criterion that only restates the title. What is left is a reading question (did a plan
 * requirement get dropped?), and only that is worth a call.
 */

/** One thing wrong with the breakdown. `task` is absent for a finding about the breakdown as a whole. */
export interface TaskFinding {
  task?: string;
  issue: string;
}

export const CoverageSchema = z.object({
  missing: z.array(z.string()).default([]).describe(
    "Plan requirements that NO task covers. Quote each one from the plan, so it can be found again."),
  weak: z.array(z.object({ task: z.string(), issue: z.string() })).default([]).describe(
    "Tasks whose acceptance criteria do not actually establish what the task claims to deliver — the work "
    + "could be marked done without the requirement being met."),
  /**
   * The question this audit was not asking, and the one that cost a 16-hour run.
   *
   * Coverage was checked in one direction only: is every requirement covered? Measured live on a 124-task
   * breakdown, the expensive gap was the other direction. `T001 — Backend: Supplier entity model` invented a
   * `Supplier` entity and a `SupplierContext` that the spec never described; the spec asks for
   * `SupplierRelationship`. The implementer built what the task said and the code reviewer rejected it for
   * not matching the spec — six times, across two roles, until the task was abandoned. 117 further tasks
   * were parked behind it and never attempted. Four of 124 landed.
   *
   * A task nothing asked for is not merely wasted work: it deadlocks, because the two halves of the
   * pipeline are reading different documents and each is right about its own.
   */
  fabricated: z.array(z.object({ task: z.string(), issue: z.string() })).default([]).describe(
    "Tasks that deliver something the plan does not ask for — an entity, a module or a behaviour that "
    + "appears in the task and nowhere in the plan. Name what the task invents and what the plan says "
    + "instead. A task that merely IMPLEMENTS a plan requirement in a reasonable way is not fabricated."),
});

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/**
 * A criterion that names something outside itself: a path, a symbol, a command, a number, a quoted value.
 *
 * The positive test, not a list of banned words. "src/models/todo.ts exports Todo" and "calling addTodo twice
 * yields two entries" are both checkable and share nothing but this: each points at something a reader can go
 * and look at.
 */
const CONCRETE = /[/\\]|\.[a-z]{1,4}\b|[a-z][A-Z]|_|\(\)|`|"|\d/;

/**
 * An acceptance criterion that only says the task is done.
 *
 * "the model is implemented" for "Implement the model" is not a completion gate — it is the title with a verb
 * moved. Deliberately crude, and deliberately biased toward letting things through: a criterion is only
 * called empty when it points at nothing concrete AND adds no word its own title did not already have. The
 * alternative is a model call for something a reader settles at a glance.
 */
const FILLER = new Set([
  "the", "and", "for", "with", "are", "was", "has", "have", "been", "should", "must", "will", "that",
  "this", "its", "done", "made", "correctly", "properly", "successfully", "works", "working", "task",
  "implemented", "implementation", "complete", "completed", "created", "added", "exists", "functional",
  "built", "written", "wired", "handled", "supported", "ready", "present", "available", "correct",
]);

export function restatesTitle(title: string, criterion: string): boolean {
  if (CONCRETE.test(criterion)) return false;
  const t = new Set(words(title));
  return words(criterion).filter((w) => !t.has(w)).every((w) => FILLER.has(w));
}

/** Structural problems, found without a model: they are facts about the board, not judgements. */
/**
 * Verbs whose whole deliverable is knowing something.
 *
 * Matched at the START of a title only. A task called "Add a failing test that verifies the fallback path"
 * produces a test; one called "Verify the fallback path" produces an opinion, and the difference is which
 * word the sentence opens with.
 */
const INVESTIGATION = /^\s*(verify|inspect|check|confirm|review|investigate|explore|understand|analyz|analys|audit|assess|examine|survey|research|determine|identify|evaluate)\w*\b/i;

/**
 * Is this task's only output an answer?
 *
 * Measured on a live run: one request became 27 cards and the first three were "Verify and anchor Nx
 * workspace environment", "Inspect existing dependencies" and "Verify linting config files". Each passed
 * every structural check — files named, acceptance criteria present, no duplicate — and each then bought an
 * implementer, a code review and an acceptance gate in order to find something out.
 *
 * Finding things out is what an implementer already does inside the task that needs the answer. As a task of
 * its own it is a round of the machinery that ends with the board no different from before.
 */
export function isInvestigation(title: string): boolean {
  return INVESTIGATION.test(title);
}

/**
 * A card whose whole content is running a command.
 *
 * Measured on the same 27-card board: "Lint @toucan/utils", "Lint @beempa/products", "Format both projects",
 * "Build Beempa production target", "Run quickstart validation" — five cards, each buying an implementer, a
 * code review and an acceptance gate in order to run one command and leave the repository as it was.
 *
 * Linting, formatting and building are how a task is known to be FINISHED. They belong in the acceptance
 * criteria of the cards that changed the code, which is where an implementer already runs them.
 *
 * "Build" is the awkward one, because it is also a word for authoring. It counts as a chore only when what
 * follows names a project or target rather than a thing being made — `Build the SafeHtmlProfile type` is work.
 */
const CHORE = /^\s*(lint|format|prettier|typecheck|type-check|compile|run|validate|execute)\w*\b/i;
const BUILD_CHORE = /^\s*build\s+(the\s+)?[\w@/.-]+\s+(project|target|app|workspace|bundle|production|package)\b/i;

export function isChore(title: string): boolean {
  return CHORE.test(title) || BUILD_CHORE.test(title);
}

/**
 * How many cards may write the same single file before the split is the problem.
 *
 * Two is a judgement — a file can hold two genuinely separate changes. Measured at five, four and three on
 * one board, it is a pattern: cards on one file cannot run in parallel (the wave engine already treats two
 * tasks writing the same file as dependent), so each extra card is another implementer, another code review
 * and another acceptance gate, in a queue, for what is one coherent change to one file.
 */
export const MAX_CARDS_PER_FILE = 2;

export function structuralFindings(board: Board): TaskFinding[] {
  const out: TaskFinding[] = [];
  const cards = board.list();
  const byTitle = new Map<string, Card[]>();
  for (const c of cards) {
    const key = c.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), c]);

    if (c.acceptance.length === 0) {
      out.push({ task: c.id, issue: "has no acceptance criteria — nothing decides when it is done" });
    } else {
      const empty = c.acceptance.filter((a) => restatesTitle(c.title, a));
      if (empty.length === c.acceptance.length) {
        out.push({ task: c.id, issue: `every acceptance criterion restates the title ("${c.acceptance[0]}") — none names a file, export, command or behaviour` });
      }
    }
    if (c.files.length === 0) {
      out.push({ task: c.id, issue: "names no files — nothing can tell whether it collides with another task" });
    }
    if (isChore(c.title)) {
      out.push({ task: c.id, issue:
        `runs a command and changes nothing — "${c.title.slice(0, 60)}". Linting, formatting and building are `
        + `how a task is known to be finished: put them in the acceptance criteria of the cards that changed `
        + `the code, where the implementer already runs them.` });
    }
    if (isInvestigation(c.title)) {
      out.push({ task: c.id, issue:
        `produces no change — "${c.title.slice(0, 60)}" delivers an answer, not a difference. Fold the `
        + `looking into the task that needs the answer, or drop it: an implementer reads the code anyway.` });
    }
  }
  /**
   * One file, split across too many cards.
   *
   * Counted on cards whose file list is exactly that one file: a card touching three files is doing something
   * broader and is not what this is about.
   */
  const soleFile = new Map<string, Card[]>();
  for (const c of cards) {
    if (c.files.length !== 1) continue;
    const f = c.files[0];
    soleFile.set(f, [...(soleFile.get(f) ?? []), c]);
  }
  for (const [file, group] of soleFile) {
    if (group.length > MAX_CARDS_PER_FILE) {
      out.push({ issue:
        `${group.length} tasks write nothing but the same file (${file}) — ${group.map((c) => c.id).join(", ")}. `
        + `Tasks on one file cannot run in parallel, so each is another implementer, code review and acceptance `
        + `gate in a queue for one coherent change. Make it one task unless they are genuinely independent.` });
    }
  }
  for (const [, group] of byTitle) {
    if (group.length > 1) {
      out.push({ issue: `${group.map((c) => c.id).join(" and ")} have the same title ("${group[0].title}") — one of them is a duplicate, or they are not really separate tasks` });
    }
  }
  return out;
}

export interface TaskAudit {
  findings: TaskFinding[];
  /** Whether the model was asked. False when the structural pass already found enough to send back. */
  asked: boolean;
}

/**
 * Board + plan → everything wrong with the breakdown. `planText` is the plan the tasks were derived from.
 *
 * `opts` may be undefined — a run whose config has no auditor role still gets the structural pass, because a
 * gate that cannot be configured away is worth more than one that takes the job down with it when it is.
 */
export async function auditBreakdown(
  opts: RoleAgentOptions | undefined, board: Board, planText: string,
  /** Ask the reading question even with structural findings open — for the board that will actually be built. */
  alwaysAsk = false,
): Promise<TaskAudit> {
  const findings = structuralFindings(board);
  /**
   * The structural pass gates the REPAIR, not the reading question — and conflating the two closed the gate
   * that mattered.
   *
   * Skipping a model call on a board that is about to be rewritten is the right economy, and it is why this
   * line exists. But `alwaysAsk` did not, so the reading question was skipped on the SECOND pass too — the
   * one run against the board that actually gets built. Measured live: a 124-card board carried 11
   * structural findings ("names no files"), a blemish that does not prevent reading anything, and the
   * fabrication question was never asked in either pass. A run then spent itself on a task nothing had
   * asked for.
   *
   * The cheap check must not be able to veto the expensive one on the board that ships.
   */
  if ((findings.length > 0 && !alwaysAsk) || !opts) return { findings, asked: false };

  const cards = board.list().map((c) =>
    `- ${c.id}: "${c.title}"\n  writes: ${c.files.join(", ") || "(none)"}\n  done when: ${c.acceptance.join("; ")}`).join("\n");
  const msg = {
    role: "user" as const,
    content:
      `The plan:\n\n${planText}\n\nThe tasks it was broken into:\n${cards}\n\n` +
      `Three questions, and only these:\n` +
      `1. missing — is there anything the plan REQUIRES that no task delivers? Quote the plan. Do not list ` +
      `work the plan does not ask for, however sensible it would be.\n` +
      `2. weak — is there a task whose acceptance criteria would still be satisfied by an implementation ` +
      `that does not do what the task says?\n` +
      `3. fabricated — the reverse of 1: is there a task that delivers something the plan never asks for? ` +
      `An entity, module or behaviour named in the task and nowhere in the plan. Name what the task ` +
      `invents AND what the plan says instead. Implementing a plan requirement in a reasonable way is not ` +
      `fabrication; inventing the requirement is.\n\n` +
      `All three lists are usually empty on a good breakdown. Return {missing, weak, fabricated} via submit.`,
  };

  try {
    const out = await runStructuredRole({ ...opts, messages: [...opts.messages, msg] }, CoverageSchema);
    return {
      asked: true,
      // Structural findings are carried through: on the second pass they are still open and still true, and
      // dropping them here would report a repaired board as clean.
      findings: [
        ...findings,
        ...out.missing.map((m) => ({ issue: `the plan requires this and no task delivers it: ${m}` })),
        ...out.weak.filter((w) => board.get(w.task)).map((w) => ({ task: w.task, issue: w.issue })),
        // Filtered against the board like `weak`: an auditor naming a task that does not exist has answered
        // about something else, and acting on it would repair a card nobody planned.
        ...out.fabricated.filter((f) => board.get(f.task)).map((f) => ({
          task: f.task, issue: `the plan does not ask for this: ${f.issue}` })),
      ],
    };
  } catch (e) {
    if (opts.signal.aborted) throw e; // abort → don't swallow it as "nothing found"
    // The gate failing must not fail the job: before it existed the breakdown was used unchecked, and that
    // is exactly what happens here.
    return { findings: [], asked: false };
  }
}

/** The findings as the project-manager is asked to fix them. */
export function repairRequest(findings: TaskFinding[]): string {
  return (
    `The task breakdown was audited before implementation and these problems were found:\n` +
    findings.map((f) => `- ${f.task ? `${f.task}: ` : ""}${f.issue}`).join("\n") +
    `\n\nProduce the whole breakdown again with these fixed. Keep every task that was fine, with its id, ` +
    `unchanged — this is a repair, not a rewrite.`
  );
}
