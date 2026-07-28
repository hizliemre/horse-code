import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { readOnlyRegistry, CODE_REVIEW_MAX_TURNS, CODE_REVIEW_TIMEOUT_MS } from "./reviewer.js";
import type { Card } from "../board/board.js";
import type { ReviewDeps } from "./review.js";
import type { ProgressEvent } from "./progress.js";
import { runProjectTests, describeTestRun } from "./test-runner.js";
import { taskDiff, describeDiff } from "./task-diff.js";
import { telemetry } from "../obs/telemetry.js";

export interface CriterionCheck { criterion: string; met: boolean; evidence: string }
export interface AcceptanceResult {
  passed: boolean;
  unmet: string[];
  /** What the project's own test suite did, when it has one. */
  tests?: { ran: boolean; passed: boolean; command?: string };
}

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
  /**
   * The suite runs FIRST, and it runs even when the card promised nothing.
   *
   * A card with no criteria used to pass trivially — nothing was promised, so nothing could be unmet. That
   * reasoning holds for criteria and not for the suite: a task can break something it never mentioned, and
   * "it promised nothing" is no reason to let a red suite through.
   */
  // Split out of the gate: a suite that takes minutes and a verifier that takes minutes are different problems.
  const suite = (): Promise<import("./test-runner.js").TestRun> =>
    deps.timings ? deps.timings.time("test suite", () => runProjectTests(cwd)) : runProjectTests(cwd);
  const tests = await telemetry().span("stage.test_suite", { "hc.stage": "test suite" }, suite);
  telemetry().event("tests.run", {
    "hc.tests.ran": !tests.skipped,
    "hc.tests.passed": tests.passed,
    "hc.tests.timed_out": tests.timedOut === true,
    "hc.tests.command": tests.command,
  });
  if (!tests.skipped) {
    emit({ kind: "note", text: tests.passed
      ? `✅ **Tests passed** for "${card.title}" — \`${tests.command}\``
      : `❌ **Tests FAILED** for "${card.title}" — \`${tests.command}\`${tests.timedOut ? " (timed out)" : ""}` });
    if (!tests.passed) {
      // Reported with the OUTPUT, not as a verdict: a suite that was already red before this task is not
      // this task's fault, and the escalation path needs to be able to tell the difference.
      return {
        passed: false,
        unmet: [
          `The project's test suite fails (\`${tests.command}\`)${tests.timedOut ? " — it timed out" : ""}. ` +
          `Nothing may enter DONE while it is red.\n${tests.output.slice(-4000)}`,
          ...card.acceptance.map((c) => `${c} (not assessed — the suite is red)`),
        ],
        tests: { ran: true, passed: false, ...(tests.command ? { command: tests.command } : {}) },
      };
    }
  }
  const testEvidence = { ran: !tests.skipped, passed: tests.passed, ...(tests.command ? { command: tests.command } : {}) };
  if (!card.acceptance.length) return { passed: true, unmet: [], tests: testEvidence };
  // The gate ran out of turns before it had opened anything, repeatedly. The change is what it is judging.
  const diff = deps.baseRef ? await taskDiff(cwd, deps.baseRef) : "";
  const resolved = deps.roleRegistry.resolve("code-reviewer");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    systemPrompt: `${PROMPT}${deps.roleRegistry.ruleSuffix()}`,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content:
      `Task: "${card.title}".\n\nAcceptance criteria:\n${card.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
      `Check each one against the worktree and report met/unmet with the evidence you saw.\n\n` +
      `${describeTestRun(tests)}\n\n${describeDiff(diff)}` }],
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
    return {
      passed: false,
      unmet: card.acceptance.map((c) => `${c} (not verified: the gate did not run)`),
      tests: testEvidence,
    };
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
  const result = { passed, unmet, tests: testEvidence };
  emit({ kind: "note", text: passed
    ? `✅ **Acceptance gate** — all ${card.acceptance.length} criteria verified for "${card.title}".`
    : `⛔ **Acceptance gate** — ${unmet.length}/${card.acceptance.length} criteria NOT met for "${card.title}".` });
  return result;
}
