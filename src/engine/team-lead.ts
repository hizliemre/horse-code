import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import { computeWaves } from "./waves.js";

/** One dependency the audit believes is wrong — either missing from the plan, or in it without cause. */
export interface DepFix {
  task: string;
  needs: string;
  why: string;
}

const fix = z.object({ task: z.string(), needs: z.string(), why: z.string() });
export const DepAuditSchema = z.object({
  missing: z.array(fix).default([]),
  spurious: z.array(fix).default([]),
});

export interface WavePlan {
  waves: string[][];
  /** Dependencies the audit added — each one pulled a task out of a wave it could not really have run in. */
  added: DepFix[];
  /** Dependencies the audit thinks are unnecessary. Reported only — see `runTeamLead`. */
  suspected: DepFix[];
}

/** Cards as the auditor sees them: everything that could reveal a dependency the breakdown did not state. */
function describeCards(board: Board): string {
  return board.list().map((c) => {
    const files = c.files.length ? `\n  writes: ${c.files.join(", ")}` : "";
    const acc = c.acceptance.length ? `\n  done when: ${c.acceptance.join("; ")}` : "";
    return `- ${c.id}: "${c.title}" deps=[${c.deps.join(", ")}]${files}${acc}`;
  }).join("\n");
}

/**
 * Waves for the board, after auditing the dependencies the breakdown declared.
 *
 * This role used to be asked to CONFIRM the waves, which was work it could not do. `computeWaves` already
 * yields the widest schedule those dependencies allow, and `validateWaves` only checked the answer against
 * the same dependencies — so the only alternative that could pass validation was a MORE SERIAL one. The call
 * could make the plan worse and had no path to making it better.
 *
 * The dependencies themselves are the part nothing verifies, and they are a judgement call about meaning:
 * task B needs a symbol task A creates. Code cannot see that (the file-conflict split catches only the case
 * where they write the SAME file); a reader of the task list can. So that is what is asked here.
 *
 * Only `missing` is applied. The two directions do not cost the same when the answer is wrong: an unnecessary
 * dependency costs some parallelism, while a removed real one sends a task off before what it needs exists —
 * it fails, and every task that depends on it is skipped, which is how a run ends "partial". `spurious` is
 * therefore reported and left in place, so its rate can be seen before anything acts on it.
 */
export async function runTeamLead(opts: RoleAgentOptions, board: Board): Promise<WavePlan> {
  const suggested = computeWaves(board);
  const parallel = suggested.filter((w) => w.length > 1);
  // Nothing runs together → nothing can collide, and there is no question worth a call.
  if (parallel.length === 0) return { waves: suggested, added: [], suspected: [] };

  const msg = {
    role: "user" as const,
    content:
      `Tasks:\n${describeCards(board)}\n\n` +
      `Given those dependencies, these groups would run AT THE SAME TIME, in separate worktrees, each ` +
      `starting from the same base:\n${parallel.map((w) => `- ${w.join(", ")}`).join("\n")}\n\n` +
      `Audit the dependencies. Two questions:\n` +
      `1. missing — is there a task in one of those groups that CANNOT run yet, because it needs something ` +
      `another task in the same group creates (a function, a type, a table, a config key)? Report only what ` +
      `would BREAK the work, not what would merely be more convenient in a different order.\n` +
      `2. spurious — is any declared dependency unnecessary, holding a task back for no reason?\n\n` +
      `Both lists are normally empty. Return {missing, spurious} via submit; each entry is ` +
      `{task, needs, why} where "task" cannot start until "needs" is done.`,
  };

  let audit: z.infer<typeof DepAuditSchema>;
  try {
    audit = await runStructuredRole({ ...opts, messages: [...opts.messages, msg] }, DepAuditSchema);
  } catch (e) {
    if (opts.signal.aborted) throw e; // abort → don't silently fall back, rethrow
    return { waves: suggested, added: [], suspected: [] }; // no submit / other error → the plan as written
  }

  const added: DepFix[] = [];
  for (const f of audit.missing) {
    if (!board.addDep(f.task, f.needs)) continue; // unknown id, self-edge, or already there
    try {
      computeWaves(board);
      added.push(f);
    } catch {
      // The edge closes a cycle: applying it would leave the board unschedulable, and one bad suggestion
      // must not cost the whole run. Drop it and keep the rest.
      board.removeDep(f.task, f.needs);
    }
  }

  return { waves: computeWaves(board), added, suspected: audit.spurious };
}
