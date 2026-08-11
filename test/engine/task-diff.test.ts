import { describe, it, expect } from "vitest";
import { taskDiff, describeDiff, MAX_DIFF_CHARS } from "../../src/engine/task-diff.js";
import type { GitRunner } from "../../src/worktree/git.js";

const git = (stdout: string, code = 0): GitRunner => async () => ({ stdout, stderr: "", code });

/**
 * Reviewers were told "review the code that implements X" and handed read/grep/glob to go and find it.
 *
 * Measured on a real board, that is where they died: `Tool-call budget was exhausted prior to inspecting code
 * changes`, `No code inspection was performed`, `I cannot complete an evidence-based review` — each recorded
 * as a REJECTION, each rejection escalating the task a tier until it was abandoned. Four of the six
 * schedulable tasks were dead that way, none of them for anything to do with the code.
 */
describe("taskDiff", () => {
  it("asks for what this branch added, not what landed on base meanwhile", async () => {
    let args: string[] = [];
    const spy: GitRunner = async (a) => { args = a; return { stdout: "diff", stderr: "", code: 0 }; };
    await taskDiff("/w", "hc/job/base", spy);
    expect(args.slice(0, 2)).toEqual(["diff", "hc/job/base...HEAD"]);
    // …and never over our own bookkeeping, which is the one file guaranteed to be in it. See excludeOwnState.
    expect(args.join(" ")).toContain(":(exclude).horsecode/**");
  });

  it("returns the diff", async () => {
    expect(await taskDiff("/w", "base", git("+ added a line"))).toBe("+ added a line");
  });

  it("says nothing rather than throwing when git fails", async () => {
    expect(await taskDiff("/w", "base", git("fatal: bad revision", 128))).toBe("");
  });

  /** It rides in the prompt of every review round; unbounded, it is re-sent on each of them. */
  it("truncates a huge diff and says where to look for the rest", async () => {
    const out = await taskDiff("/w", "base", git("x".repeat(MAX_DIFF_CHARS * 2)));
    expect(out.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    expect(out).toContain("truncated");
    expect(out).toContain("read the remaining files");
  });
});

describe("describeDiff", () => {
  it("presents the diff as the subject of the review", () => {
    const s = describeDiff("+ x");
    expect(s).toContain("```diff");
    expect(s).toMatch(/read it first/);
  });

  /** Silence would read as "nothing changed", which is a different claim entirely. */
  it("says the diff is missing rather than implying there was none", () => {
    const s = describeDiff("   ");
    expect(s).toMatch(/could not be produced/);
    expect(s).toContain("read_file");
  });
});
