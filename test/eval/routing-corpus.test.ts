import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadGraphSync } from "../../src/engine/project-graph.js";
import { evaluateFileResolution, evaluateUiDetection, codeFiles, parseGitLog } from "../../src/eval/route-eval.js";

/**
 * Measures routing against a corpus nobody wrote for it: this repository's own history.
 *
 * Opt-in (`HC_EVAL=1`) because it needs a built graph and its numbers are a measurement, not a pass/fail —
 * asserting them would turn a change in the repository's commit history into a test failure. Run it after
 * touching anything in `src/skills/route.ts`:
 *
 *   HC_EVAL=1 npx vitest run test/eval
 *
 * What it can and cannot tell you: file resolution is measurable here because an identifier is an identifier
 * whatever language the commit subject is in. Whether the right SKILL was then chosen is not — this repo's
 * subjects are not in the language the skill descriptions are written in, and its `.tsx` files are terminal
 * UI rather than the web interfaces the design skills describe. For that, point this at a real frontend repo.
 */
const enabled = !!process.env.HC_EVAL && existsSync("graphify-out/graph.json");

describe.skipIf(!enabled)("routing against real commit history", () => {
  const samples = parseGitLog(execSync('git log -400 --format="___%s" --name-only', { maxBuffer: 40e6 }).toString());
  const graph = loadGraphSync(process.cwd())!;
  const log = (s: string): void => { process.stderr.write(`  ${s}\n`); };

  it("file resolution", () => {
    log(`corpus: ${samples.filter((s) => codeFiles(s.files).length).length} commits touching source`);
    for (const max of [1, 3, 8]) {
      const m = evaluateFileResolution(samples, graph, max);
      log(`max=${max}  resolved ${(100 * m.resolved / m.samples).toFixed(0)}%` +
        `  exact-path ${(100 * m.precision).toFixed(0)}%` +
        `  kind ${(100 * m.kindPrecision).toFixed(0)}%` +
        `  recall ${(100 * m.recall).toFixed(0)}%`);
    }
    expect(samples.length).toBeGreaterThan(0);
  });

  /** The decision routing actually makes. Kind-precision flatters itself on a repo that is 86% one extension. */
  it("UI detection", () => {
    const m = evaluateUiDetection(samples, graph);
    log(`UI  precision ${(100 * m.precision).toFixed(0)}%  recall ${(100 * m.recall).toFixed(0)}%` +
      `  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`);
    log(`    baseline "never UI" accuracy ${(100 * m.baselineAccuracy).toFixed(0)}%, ours ${(100 * m.accuracy).toFixed(0)}%`);
    expect(m.tp + m.fn).toBeGreaterThan(0);
  });
});
