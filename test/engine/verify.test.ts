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
