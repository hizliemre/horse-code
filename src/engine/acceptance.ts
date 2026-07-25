import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { readOnlyRegistry, CODE_REVIEW_MAX_TURNS, CODE_REVIEW_TIMEOUT_MS } from "./reviewer.js";
import type { Card } from "../board/board.js";
import type { ReviewDeps } from "./review.js";
import type { ProgressEvent } from "./progress.js";

export interface CriterionCheck { criterion: string; met: boolean; evidence: string }
export interface AcceptanceResult { passed: boolean; unmet: string[] }

const AcceptanceSchema = z.object({
  checks: z.array(z.object({
    criterion: z.string(),
    met: z.boolean(),
    /** Where you SAW it: a file path (+ what it contains), a symbol, a test name. "It looks fine" is not evidence. */
    evidence: z.string(),
  })),
});

const PROMPT =
  "You are the acceptance gate for one implementation task. You are given the task's acceptance criteria and " +
  "read-only access to the worktree. For EACH criterion decide whether it is ACTUALLY satisfied by the code " +
  "that is present, and cite the concrete evidence you saw (file path, symbol, test name, config key).\n" +
  "Rules:\n" +
  '- Verify by LOOKING. If you did not open the file, the criterion is not met.\n' +
  '- "met" means observably true right now — not "planned", "close enough" or "the implementer says so".\n' +
  "- Judge ONLY the listed criteria. Code quality, style and scope opinions belong to the code review, not here.\n" +
  "- Write the evidence in ENGLISH (it is a technical record).";

/**
 * The completion gate: a task may only enter DONE when its acceptance criteria are observably satisfied.
 *
 * The code review answers "is this code good?"; it cannot answer "was the thing we asked for actually built?" —
 * an implementation that quietly does half the task passes review while the requirement silently disappears.
 * This step re-reads the worktree and demands evidence per criterion. A task with no criteria passes trivially
 * (nothing was promised), so this never blocks a plan that predates the gate.
 */
export async function verifyAcceptance(
  deps: ReviewDeps, card: Card, cwd: string, emit: (ev: ProgressEvent) => void = () => {},
): Promise<AcceptanceResult> {
  if (!card.acceptance.length) return { passed: true, unmet: [] };
  const resolved = deps.roleRegistry.resolve("code-reviewer");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    systemPrompt: `${PROMPT}${deps.roleRegistry.ruleSuffix()}`,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content:
      `Task: "${card.title}".\n\nAcceptance criteria:\n${card.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
      `Check each one against the worktree and report met/unmet with the evidence you saw.` }],
    permission: deps.permission, approve: deps.approve, cwd,
    signal: AbortSignal.any([deps.signal, AbortSignal.timeout(CODE_REVIEW_TIMEOUT_MS)]),
    maxTurns: CODE_REVIEW_MAX_TURNS,
  };
  let checks: CriterionCheck[];
  try {
    ({ checks } = await runStructuredRole(opts, AcceptanceSchema));
  } catch (e) {
    if (deps.signal.aborted) throw e;
    // Fail-SAFE: an unverifiable gate must not wave the task through — that is exactly the silent-success
    // failure the gate exists to prevent.
    emit({ kind: "note", text: `⚠️ **Acceptance gate** could not run for "${card.title}" — treating the criteria as unmet.` });
    return { passed: false, unmet: card.acceptance.map((c) => `${c} (not verified: the gate did not run)`) };
  }
  // A criterion the gate never reported on is NOT satisfied — silence is not evidence.
  const byCriterion = new Map(checks.map((c) => [c.criterion.trim().toLowerCase(), c]));
  const unmet: string[] = [];
  for (const c of card.acceptance) {
    const hit = byCriterion.get(c.trim().toLowerCase())
      ?? checks.find((x) => x.criterion.toLowerCase().includes(c.trim().toLowerCase().slice(0, 40)));
    if (!hit) unmet.push(`${c} (not reported by the acceptance gate)`);
    else if (!hit.met) unmet.push(`${c} — ${hit.evidence}`);
  }
  const passed = unmet.length === 0;
  emit({ kind: "note", text: passed
    ? `✅ **Acceptance gate** — all ${card.acceptance.length} criteria verified for "${card.title}".`
    : `⛔ **Acceptance gate** — ${unmet.length}/${card.acceptance.length} criteria NOT met for "${card.title}".` });
  return { passed, unmet };
}
