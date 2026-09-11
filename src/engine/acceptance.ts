import { z } from "zod";
import { runCriterionCommands, describeCommandRuns } from "./criterion-commands.js";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { readOnlyRegistry, CODE_REVIEW_MAX_TURNS, CODE_REVIEW_TIMEOUT_MS } from "./reviewer.js";
import type { Card } from "../board/board.js";
import type { ReviewDeps } from "./review.js";
import type { ProgressEvent } from "./progress.js";
import { runProjectTests, describeTestRun } from "./test-runner.js";
import { taskDiff, diffSince, describeDiff } from "./task-diff.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { telemetry } from "../obs/telemetry.js";

export interface CriterionCheck { criterion: string; met: boolean; evidence: string }
export interface AcceptanceResult {
  passed: boolean;
  unmet: string[];
  /** What the project's own test suite did, when it has one. */
  tests?: { ran: boolean; passed: boolean; command?: string };
}

/**
 * The key a criterion is paired on, with everything the model is free to reformat taken out.
 *
 * The gate asks for each criterion to be restated and then matches the restatement back to the card by
 * string. That made pairing depend on Markdown markup surviving the round trip: a criterion opening with an
 * inline-code span was reported as "not reported by the acceptance gate" — which reads like a missing
 * implementation but only ever meant "no check paired to this string". Markup, whitespace runs and trailing
 * punctuation are presentation; the words are the identity.
 */
function normalizeCriterion(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/, "");
}

const AcceptanceSchema = z.object({
  checks: z.array(z.object({
    criterion: z.string().describe(
      "Copy the criterion VERBATIM from the numbered list you were given, including any backticks and "
      + "punctuation. Do not paraphrase, renumber or reformat it — it is matched back to the task by text."),
    met: z.boolean(),
    evidence: z.string().describe(
      "Where you SAW it: a file path and what it contains, a symbol, a test name. \"It looks fine\" is not "
      + "evidence."),
  })),
});

const PROMPT =
  "You are the acceptance gate for one implementation task. You are given the task's acceptance criteria and " +
  "the worktree. For EACH criterion decide whether it is ACTUALLY satisfied by the code " +
  "that is present, and cite the concrete evidence you saw (file path, symbol, test name, config key).\n" +
  "Rules:\n" +
  '- Verify by LOOKING. If you did not open the file, the criterion is not met.\n' +
  /**
   * The rule above is right about code and was wrong about commands, and the gate had no way to tell.
   * Told to verify by looking, and handed "`dotnet build` succeeds", it started the build itself, ran out of
   * patience at 210 seconds, and failed the card for a build that was fine.
   */
  '- A criterion about a COMMAND is settled by the run reported to you above, not by looking and not by '
  + 'running it yourself. If that report says the command succeeded, the criterion is met; if it failed, '
  + 'quote the error. Never mark such a criterion unmet for want of waiting.\n' +
  '- "met" means observably true right now — not "planned", "close enough" or "the implementer says so".\n' +
  "- Judge ONLY the listed criteria. Code quality, style and scope opinions belong to the code review, not here.\n" +
  "- Report EVERY criterion you were given — one check each, none dropped.\n" +
  "- Copy each criterion into the \"criterion\" field VERBATIM from the numbered list, including any backticks " +
  "and punctuation. It is matched back to the task by text; a paraphrase loses the pairing.\n" +
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
  /**
   * How the criteria's commands get run — injected so a test does not depend on the machine running it.
   *
   * The gate SPAWNS by design: a criterion naming `dotnet build` is settled by running it, which is the whole
   * point of `runCriterionCommands`. That made every test carrying such a criterion reach for the local
   * toolchain, and the behaviour then differed by machine. Measured: the pairing test took 250ms on a laptop
   * with the .NET SDK installed, and on CI — where the runner image also has it, and a cold first run is far
   * slower — it passed the 5-second timeout and failed a release whose code was fine.
   *
   * Real runs keep the real runner; tests hand in one that spawns nothing.
   */
  runCommands: typeof runCriterionCommands = runCriterionCommands,
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
  // …and in place, from where the work started — auto-commits move HEAD, so a diff against it is empty.
  const diff = deps.baseRef ? await taskDiff(cwd, deps.baseRef)
    : deps.inPlaceBase ? await diffSince(cwd, deps.inPlaceBase) : "";
  const resolved = deps.roleRegistry.resolve("code-reviewer");
  /**
   * The final gate gets what earlier runs learned, exactly as the per-task reviewer does.
   *
   * Two gates judge the same code with the same role, and only one of them could see the store — so a lesson
   * that stopped a defect at review had nothing to say when the same defect reached acceptance. Retrieved on
   * the card, not on the assembled message: the criteria and the diff are the subject, the instructions
   * around them are the same on every call.
   */
  /**
   * The commands the criteria name are run HERE, by the harness, before the gate is asked anything.
   *
   * Measured over one board: of 112 acceptance criteria, 29 named a command and those 29 produced 37 of the
   * 39 acceptance failures — while the 83 that can be checked by reading produced two. The gate was giving
   * up on builds it had started itself ("more than 210 seconds total, so a successful build was not
   * observably verified") and the card came back for a build that was fine.
   */
  const commandRuns = await telemetry().span("stage.criterion_commands", { "hc.stage": "criterion commands" },
    () => runCommands(cwd, card.acceptance));
  for (const r of commandRuns) {
    emit({ kind: "note", text: r.passed
      ? `✅ \`${r.argv.join(" ")}\` — exit 0`
      : `❌ \`${r.argv.join(" ")}\` — ${r.timedOut ? "timed out" : `exit ${r.exitCode ?? "none"}`}` });
  }

  const hints = memoryHints(deps, `${card.title} ${card.acceptance.join(" ")}`, { role: "code-reviewer" });
  const ask = { role: "user" as const, content:
    `Task: "${card.title}".\n\nAcceptance criteria:\n${card.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
    `Check each one against the worktree and report met/unmet with the evidence you saw.\n\n` +
    `${describeTestRun(tests)}\n\n${describeCommandRuns(commandRuns)}\n\n${describeDiff(diff)}` };
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    systemPrompt: `${PROMPT}${deps.roleRegistry.ruleSuffix()}`,
    tools: readOnlyRegistry(deps),
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission, approve: deps.approve, cwd,
    signal: AbortSignal.any([deps.signal, AbortSignal.timeout(CODE_REVIEW_TIMEOUT_MS)]),
    maxTurns: CODE_REVIEW_MAX_TURNS,
  };
  let checks: CriterionCheck[];
  try {
    ({ checks } = await runStructuredRole(opts, AcceptanceSchema));
    // Credit what the verdict actually leaned on, or the store only learns that memories were sent.
    reinforceUsed(deps, hints.ids, checks.map((c) => c.evidence).join(" "), "code-reviewer");
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
  const byCriterion = new Map(checks.map((c) => [normalizeCriterion(c.criterion), c]));
  const paired = new Map<string, CriterionCheck>();
  const usedChecks = new Set<CriterionCheck>();
  const unpairedCriteria: string[] = [];
  for (const c of card.acceptance) {
    const key = normalizeCriterion(c);
    const hit = byCriterion.get(key)
      ?? checks.find((x) => normalizeCriterion(x.criterion).includes(key.slice(0, 40)));
    if (hit) { paired.set(c, hit); usedChecks.add(hit); }
    else unpairedCriteria.push(c);
  }
  /**
   * Last resort, and deliberately only when it is unambiguous: one criterion left, one check left, so there
   * is exactly one way to pair them. With two of either the mapping is a guess, and guessing here would turn
   * the gate's silence into a pass — the precise failure it exists to prevent. So they stay unpaired and
   * `(not reported by the acceptance gate)` still fires.
   */
  const unusedChecks = checks.filter((x) => !usedChecks.has(x));
  if (unpairedCriteria.length === 1 && unusedChecks.length === 1) {
    paired.set(unpairedCriteria[0]!, unusedChecks[0]!);
  }
  const unmet: string[] = [];
  for (const c of card.acceptance) {
    const hit = paired.get(c);
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
