import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { routeIntent, RefinerSchema } from "../../src/engine/refiner.js";
import { featureSlugFor, verifyPaths, specsDir } from "../../src/speckit/layout.js";
import { REQUIRED_ROLES, DEFAULT_PROMPTS } from "../../src/prompts.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-verify-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/**
 * Exercising work that already exists is not producing work.
 *
 * `govern` is the precedent: establishing the project's constitution was classified as a feature, and that
 * bought it the whole pipeline — a worktree cut from a branch, a spec, a plan, a board, waves — for an output
 * that is one document belonging to the project the user is standing in. Running a PR's test scenarios has the
 * same shape: nothing is being built, the output is a report, and the user is present the whole time because
 * the environment is theirs to start.
 */
describe("verify is its own intent, not a feature", () => {
  it("routes to its own lane rather than to the pipeline", () => {
    expect(routeIntent("verify")).toBe("verify");
    // …and the intents that DO produce software still go where they went.
    expect(routeIntent("feature")).toBe("pipeline");
    expect(routeIntent("bugfix")).toBe("pipeline");
  });

  it("is a value the refiner can actually return", () => {
    const r = RefinerSchema.safeParse({ refinedPrompt: "Run the smoke tests for PR 677", intent: "verify" });
    expect(r.success).toBe(true);
  });
});

describe("everything one run produces lands in one folder", () => {
  it("puts the test plan and the report beside the spec and the plan", () => {
    const p = verifyPaths(cwd, "002-product-create-wizard");
    const dir = join(specsDir(cwd), "002-product-create-wizard");
    expect(p.dir).toBe(dir);
    expect(p.plan).toBe(join(dir, "test-plan.md"));
    expect(p.report).toBe(join(dir, "test-report.md"));
    // Nothing escapes the folder — that is the whole rule.
    for (const f of [p.plan, p.report]) {
      const rel = relative(dir, f);
      expect(isAbsolute(rel) || rel.startsWith("..")).toBe(false);
    }
  });

  /**
   * A verify run is usually a SECOND visit to work that already has a folder — the feature was built, and now
   * its scenarios are being run. Numbering a new one would scatter the account of one piece of work across
   * two directories, which is exactly what this convention exists to prevent.
   */
  it("returns to the folder the work already has, instead of opening a second one", async () => {
    await mkdir(join(specsDir(cwd), "001-safe-html-pipe-dompurify"), { recursive: true });
    await mkdir(join(specsDir(cwd), "002-product-create-wizard"), { recursive: true });
    expect(featureSlugFor(cwd, "product create wizard")).toBe("002-product-create-wizard");
    expect(featureSlugFor(cwd, "safe-html-pipe-dompurify")).toBe("001-safe-html-pipe-dompurify");
  });

  it("opens the next numbered folder when the work has none", async () => {
    await mkdir(join(specsDir(cwd), "001-something-else"), { recursive: true });
    expect(featureSlugFor(cwd, "product create wizard")).toBe("002-product-create-wizard");
  });

  it("starts at 001 in a project that has never run one", () => {
    expect(featureSlugFor(cwd, "first thing")).toBe("001-first-thing");
  });

  /**
   * The same work, asked for in different words, is still the same work.
   *
   * Measured across two runs a few minutes apart: "continue testing the product creation wizard" produced
   * `002-product-wizard-testing`, and "continue running the smoke tests for the product creation wizard"
   * produced `003-product-creation-wizard-smoke-tests`. Exact-name matching cannot see that those are one
   * piece of work, and every rephrasing opened another directory beside the last.
   */
  it("returns to the folder even when the request is phrased differently", async () => {
    await mkdir(join(specsDir(cwd), "002-product-wizard-testing"), { recursive: true });
    expect(featureSlugFor(cwd, "product creation wizard smoke tests")).toBe("002-product-wizard-testing");
    expect(featureSlugFor(cwd, "testing the product wizard")).toBe("002-product-wizard-testing");
  });

  /** …but a different piece of work that merely shares a word is not the same work. */
  it("does not drag an unrelated request into someone else's folder", async () => {
    await mkdir(join(specsDir(cwd), "001-product-wizard-testing"), { recursive: true });
    expect(featureSlugFor(cwd, "product list page")).toBe("002-product-list-page");
    expect(featureSlugFor(cwd, "wizard for invoices")).toBe("002-wizard-for-invoices");
  });

  /**
   * "test", "smoke", "verify" say what is being DONE, not what it is being done to. Matching on them would
   * put every verification the project ever runs into whichever folder was numbered first.
   */
  it("matches on the subject, not on the word 'test'", async () => {
    await mkdir(join(specsDir(cwd), "001-wallet-balance-tests"), { recursive: true });
    // toSlug keeps the first five words, so the trailing "flow" is not part of the name.
    expect(featureSlugFor(cwd, "smoke tests for the checkout flow")).toBe("002-smoke-tests-for-the-checkout");
  });
});

describe("the tester is a real role", () => {
  it("is one the model tuner must assign", () => {
    expect(REQUIRED_ROLES).toContain("tester");
  });

  /**
   * The rules below are not style. Each one is a project constitution's article XII, and each is the
   * difference between a report worth reading and one that manufactures confidence: an unexecuted scenario
   * reported as passed is worse than no test at all.
   */
  it("carries the rules that make a report worth reading", () => {
    const p = DEFAULT_PROMPTS.tester;
    expect(p).toBeTruthy();
    expect(p).toMatch(/evidence/i);                       // a result without it is not a result
    expect(p).toMatch(/never.*(passed|PASSED)/i);         // …so it may not be claimed
    expect(p).toMatch(/not executed|did not run/i);       // the honest label for what could not be run
    expect(p).toMatch(/never start|do not start/i);       // the environment is the developer's to run
    expect(p).toMatch(/before moving on|one at a time/i); // the report is living, not written at the end
  });

  it("does not invent a verdict vocabulary of its own", () => {
    expect(DEFAULT_PROMPTS.tester).toMatch(/PASSED/);
    expect(DEFAULT_PROMPTS.tester).toMatch(/FAILED/);
  });
});

/**
 * Detect → write it down → hand off → fix → come back → re-check → say so in the same entry.
 *
 * The loop that folds a fix back into the verification already existed; what it never did was leave a trace
 * at the moment of detection. The queue is in memory, so a session that stopped before the fix round — the
 * environment goes down, the budget runs out — took every finding with it, against the tester's own rule that
 * a run stopping halfway must leave behind everything it learned. And after a fix, nothing said to update the
 * finding's own entry: the scenario got its fresh evidence while the finding went on reading OPEN.
 */
describe("a finding's round trip", () => {
  const src = async (p: string): Promise<string> =>
    (await import("node:fs/promises")).readFile(p, "utf8");

  it("is written into the report the moment it is reported, not at the end", async () => {
    const s = await src("src/engine/finding.ts");
    expect(s).toMatch(/Write it into the report now/);
    expect(s).toMatch(/\*\*Findings\*\* section, as OPEN/);
  });

  it("tells the tester the fix is coming back to it, so the hand-off is not a goodbye", async () => {
    const s = await src("src/engine/finding.ts");
    expect(s).toMatch(/you will be told the outcome so you can re-check it/);
    expect(s).toMatch(/do not fix it yourself/);
  });

  it("asks for that entry to be updated after the re-check, not just the scenario", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toMatch(/Update each finding's OWN entry in the report/);
    expect(s).toMatch(/FIXED and verified, with the evidence/);
    expect(s).toMatch(/still OPEN and what you saw this time/);
  });

  it("says why a stale entry matters, so the rule is not decoration", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toMatch(/as wrong as one marked fixed that was not/);
  });

  it("still re-runs the affected scenarios against the corrected product", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toMatch(/against the corrected product, with fresh evidence/);
    expect(s).toMatch(/carry on from where you were/);
  });
});
