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
  /** Plan requirements with no task at all. Each entry is quoted from the plan. */
  missing: z.array(z.string()).default([]),
  /** Tasks whose acceptance criteria do not actually establish what the task claims to deliver. */
  weak: z.array(z.object({ task: z.string(), issue: z.string() })).default([]),
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
export async function auditBreakdown(opts: RoleAgentOptions | undefined, board: Board, planText: string): Promise<TaskAudit> {
  const findings = structuralFindings(board);
  // Already sending it back: the reading pass costs a call and would only lengthen a list that is acted on
  // whole. It runs on the repaired board instead, where its answer still matters.
  if (findings.length > 0 || !opts) return { findings, asked: false };

  const cards = board.list().map((c) =>
    `- ${c.id}: "${c.title}"\n  writes: ${c.files.join(", ") || "(none)"}\n  done when: ${c.acceptance.join("; ")}`).join("\n");
  const msg = {
    role: "user" as const,
    content:
      `The plan:\n\n${planText}\n\nThe tasks it was broken into:\n${cards}\n\n` +
      `Two questions, and only these:\n` +
      `1. missing — is there anything the plan REQUIRES that no task delivers? Quote the plan. Do not list ` +
      `work the plan does not ask for, however sensible it would be.\n` +
      `2. weak — is there a task whose acceptance criteria would still be satisfied by an implementation ` +
      `that does not do what the task says?\n\n` +
      `Both lists are usually empty on a good breakdown. Return {missing, weak} via submit.`,
  };

  try {
    const out = await runStructuredRole({ ...opts, messages: [...opts.messages, msg] }, CoverageSchema);
    return {
      asked: true,
      findings: [
        ...out.missing.map((m) => ({ issue: `the plan requires this and no task delivers it: ${m}` })),
        ...out.weak.filter((w) => board.get(w.task)).map((w) => ({ task: w.task, issue: w.issue })),
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
