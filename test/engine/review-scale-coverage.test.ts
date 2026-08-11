import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lensesFor, CORE_CODE_LENSES, SMALL_CHANGE_LINES, TEAM_MIN_COVERAGE, changedLines } from "../../src/engine/review.js";
import { workingTreeDiff } from "../../src/engine/task-diff.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "../worktree/helpers.js";
import { CODE_TEAM } from "../../src/prompts.js";

let repo = "";
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = ""; });

/**
 * The cheapest path was convening the most expensive review.
 *
 * `taskDiff` compares commits, and the small-change path never makes one until the work is accepted — it
 * edits the tree in place. So it asked for a diff, got nothing, and every downstream decision took the
 * safe-but-wrong branch. Measured live: `hc.task.id: "small-1"`, `hc.changed_lines: 0`, `hc.lenses: 15`.
 * Then, with no diff handed to them, the lenses went looking: `code-api-surface` made 111 tool calls and
 * `code-simplicity` 109, against a budget written for "under ten turns" — and nine of the fifteen ran past
 * their 180s ceiling. The round committed nothing after 41 minutes and 8.3M tokens.
 */
describe("the size of a working-tree change is knowable", () => {
  it("reads what the tree holds that HEAD does not", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "README.md"), "# repo\nchanged\n", "utf8");
    const diff = await workingTreeDiff(repo, defaultGitRunner);
    expect(diff).toContain("README.md");
    expect(changedLines(diff)).toBeGreaterThan(0);
  });

  it("is empty on a clean tree, rather than throwing", async () => {
    repo = await initTmpRepo();
    expect(await workingTreeDiff(repo, defaultGitRunner)).toBe("");
  });

  it("lets a small working-tree change convene the core lenses only", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "README.md"), "# repo\none small line\n", "utf8");
    const team = lensesFor(CODE_TEAM, await workingTreeDiff(repo, defaultGitRunner));
    expect(team.length).toBeLessThan(CODE_TEAM.length);
    expect(team.map((c) => c.name).sort()).toEqual([...CORE_CODE_LENSES].sort());
  });

  it("still convenes everyone for a change that is not small", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "big.ts"), Array.from({ length: SMALL_CHANGE_LINES + 20 }, (_, i) => `const x${i} = ${i};`).join("\n"), "utf8");
    await defaultGitRunner(["add", "-A"], repo);
    const team = lensesFor(CODE_TEAM, await workingTreeDiff(repo, defaultGitRunner));
    expect(team.length).toBe(CODE_TEAM.length);
  });
});

/**
 * "I did not finish" and "I found something wrong" are different facts.
 *
 * Counting them as one threw the work away: nine unfinished lenses each returned a critical UNVERIFIED
 * finding, the council read nine criticals and voted to revise, and not one of the nine had found a defect.
 */
describe("an unfinished lens is a coverage gap, not a defect", () => {
  const lens = (name: string, rec: "approve" | "revise", sev?: "critical") => ({
    name, recommendation: rec,
    findings: sev ? [{ severity: sev, note: "x" }] : [],
  });
  const unfinished = (name: string) => ({ ...lens(name, "revise", "critical"), unverified: true });

  it("keeps the coverage floor, so a review nobody completed cannot pass by silence", () => {
    expect(TEAM_MIN_COVERAGE).toBeGreaterThan(0.5);
    expect(TEAM_MIN_COVERAGE).toBeLessThan(1);
  });

  it("marks the unfinished lens, so the decision can tell the two apart", () => {
    const a = unfinished("code-tests");
    expect(a.unverified).toBe(true);
    expect(a.findings[0]!.severity).toBe("critical");   // still says so, loudly
  });

  it("counts findings only from lenses that reached a verdict", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/review.ts", "utf8");
    expect(src).toContain(".filter((a) => !a.unverified)");
    expect(src).toContain("const verdicts = assessments.filter((a) => !a.unverified);");
    // …and consensus is over those, or nine unfinished put 6/15 on the board before an opinion was read.
    expect(src).toContain("approve / verdicts.length >= TEAM_CONSENSUS");
  });
});

/**
 * The hole the existing suite caught.
 *
 * The coverage floor went into the team loop and not into the single-shot code review, so a one-lens team
 * whose lens never produced a valid verdict turned `fail` into `pass` — nought reviewed, approved. Discounting
 * an unfinished lens is only safe while enough of them finished.
 */
describe("the single-shot code review has the same floor", () => {
  it("refuses to pass a change whose review never ran", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/review.ts", "utf8");
    const guard = src.indexOf("const cover = coverage(assessments);\n  if (!cover.enough) {");
    const decision = src.indexOf("if (crit === 0) {\n    const deferred = nonBlockingNotes(assessments, \"code\");");
    expect(guard).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(guard);      // the floor is checked BEFORE the pass decision
  });

  it("says what to do about it, rather than only that it happened", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/review.ts", "utf8");
    expect(src).toMatch(/too little of `\s*\+\s*`the review ran to judge this change/);
    expect(src).toMatch(/the lens's model chain is the fault/);
  });
});
