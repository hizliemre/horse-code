import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDocDirs, readPointer, POINTER_HINT } from "../../src/engine/verify.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-vex-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/**
 * A project that has been tested before has the documents to show for it, and they are not where horse-code
 * would have put them.
 *
 * Measured on a real one: `docs/superpowers/test-plans/2026-07-12-product-create-wizard-e2e.md`, 813 lines,
 * naming the very pull request being verified, with thirteen backend scenarios already PASSED and the frontend
 * ones PENDING — beside 236 siblings. Looking only at `specs/<slug>/test-plan.md`, horse-code announced there
 * was no plan and offered to write one: a second document, and the record of what had already passed lost.
 */
describe("where this project keeps its test documents", () => {
  it("finds the directories from what git tracks, busiest first", () => {
    const dirs = testDocDirs([
      "docs/superpowers/test-plans/a-e2e.md",
      "docs/superpowers/test-plans/b-e2e.md",
      "docs/superpowers/test-plans/c-test-plan.md",
      "docs/superpowers/test-reports/x-test-report.md",
      "src/app.ts",
      "README.md",
    ]);
    expect(dirs[0]).toBe("docs/superpowers/test-plans");
    expect(dirs).toContain("docs/superpowers/test-reports");
    expect(dirs).not.toContain("src");
  });

  it("says nothing about a project that has never written one", () => {
    expect(testDocDirs(["src/app.ts", "package.json"])).toEqual([]);
  });

  /** A handful of directories is a hint; a list of 237 filenames is the search the tester is there to do. */
  it("returns directories, not the documents themselves", () => {
    const many = Array.from({ length: 237 }, (_, i) => `docs/superpowers/test-plans/doc-${i}-e2e.md`);
    const dirs = testDocDirs(many);
    expect(dirs).toEqual(["docs/superpowers/test-plans"]);
  });

  it("does not mistake source that merely has 'test' in the name", () => {
    expect(testDocDirs(["src/testing/helpers.ts", "test/unit/app.spec.ts"])).toEqual([]);
  });
});

describe("the pointer that keeps both rules", () => {
  it("reads the document the run is actually continuing", async () => {
    await mkdir(join(cwd, "specs", "002-x"), { recursive: true });
    await writeFile(join(cwd, "specs", "002-x", "test-report.md"),
      `# Test report\n\nContinued in place.\n\n<!-- report: docs/superpowers/test-plans/wizard-e2e.md -->\n`, "utf8");
    expect(readPointer(join(cwd, "specs", "002-x", "test-report.md"))).toBe("docs/superpowers/test-plans/wizard-e2e.md");
  });

  it("reads nothing from a report that is the results themselves", async () => {
    await mkdir(join(cwd, "specs", "002-x"), { recursive: true });
    await writeFile(join(cwd, "specs", "002-x", "test-report.md"), "# Test report\n\n| S1 | PASSED |\n", "utf8");
    expect(readPointer(join(cwd, "specs", "002-x", "test-report.md"))).toBeUndefined();
  });

  it("reads nothing when there is no file at all", () => {
    expect(readPointer(join(cwd, "nope.md"))).toBeUndefined();
  });

  /** The instruction and the reader must agree on the marker, or the pointer is written and never read. */
  it("tells the tester the exact marker it will be read back with", () => {
    expect(POINTER_HINT).toContain("<!-- report:");
  });
});

/**
 * Telling the tester where a project keeps its test documents is an invitation to write the NEW one there
 * too — the opposite of the rule. Work that horse-code started has no document in those older directories,
 * and its plan and report must land in the run's own folder like everything else it produces.
 */
describe("a new document goes in the run's folder, not where the old ones live", () => {
  it("says so explicitly, next to the hint that could be read the other way", async () => {
    const { planMessageFor } = await import("../../src/engine/verify.js");
    const msg = planMessageFor(
      "verify the wizard", "specs/002-wizard/test-plan.md", "specs/002-wizard/test-report.md",
      "specs/002-wizard", ["docs/superpowers/test-plans"]);
    expect(msg).toContain("specs/002-wizard/test-plan.md");
    expect(msg).toMatch(/nowhere else/i);
    expect(msg).toMatch(/not where a new\s+document goes/i);
    // …and the hint is still there, or the tester searches blind through the whole repository.
    expect(msg).toContain("docs/superpowers/test-plans");
  });

  /**
   * A request that names the check does not need a plan written for it.
   *
   * Measured live: "Confirm from the screenshot that the description renders raw HTML instead of three
   * lines" — the tester searched, found no document, refused to invent one, and asked the user for the file.
   * Six calls, one minute, "nothing was verified", for a question that could have been answered.
   */
  it("says that a named check is its own plan", async () => {
    const { planMessageFor } = await import("../../src/engine/verify.js");
    const msg = planMessageFor("confirm X renders as Y", "specs/002-x/test-plan.md", "specs/002-x/test-report.md",
      "specs/002-x", ["docs/superpowers/test-plans"]);
    expect(msg).toMatch(/that IS the plan/i);
    expect(msg).toMatch(/write nothing/i);
    expect(msg).toMatch(/ONLY IF NEITHER/);   // …and the plan is still written when neither applies
  });

  it("still names the run's folder when the project keeps no test documents at all", async () => {
    const { planMessageFor } = await import("../../src/engine/verify.js");
    const msg = planMessageFor("verify it", "specs/001-x/test-plan.md", "specs/001-x/test-report.md", "specs/001-x", []);
    expect(msg).toContain("specs/001-x/test-plan.md");
    expect(msg).toMatch(/Search the repository/i);
  });
});

/**
 * Two claims in one line, one of them wrong.
 *
 * The report said "On branch `hc/05-Aug-2026-WEDNESDAY_01/base` — uncommitted, in your working tree" — a
 * branch that only exists inside a session worktree, described as if it were the checkout the user is
 * standing in. The cause was quiet: the result's `dir` is RELATIVE (`specs/004-…`), so asking `sessionBase`
 * about it always answered "not in a session". The wrong half sends someone looking in a directory that does
 * not have the file.
 */
describe("where the report says the work is", () => {
  const result = {
    dir: "specs/004-wizard-smoke-test",
    planPath: "specs/004-wizard-smoke-test/test-plan.md",
    reportPath: "specs/004-wizard-smoke-test/test-report.md",
    planWritten: true, reportWritten: true,
  };

  it("names the worktree when the run worked in a session", async () => {
    const { describeVerify } = await import("../../src/engine/verify.js");
    const said = describeVerify(result, "hc/05-Aug-2026-WEDNESDAY_01/base",
      "/p/.horsecode/worktrees/05-Aug-2026-WEDNESDAY_01/base");
    expect(said).toContain("/p/.horsecode/worktrees/05-Aug-2026-WEDNESDAY_01/base");
    expect(said).toMatch(/merge it in/i);
    expect(said).not.toMatch(/in your working tree/i);
  });

  it("keeps the old words when the run really was in the working tree", async () => {
    const { describeVerify } = await import("../../src/engine/verify.js");
    const said = describeVerify(result, "development", "/p");
    expect(said).toMatch(/in your working tree/i);
  });

  /** Without a working directory there is nothing to resolve against — say the safe thing. */
  it("does not guess when it was not told where the run was", async () => {
    const { describeVerify } = await import("../../src/engine/verify.js");
    expect(describeVerify(result, "development")).toMatch(/in your working tree/i);
  });
});
