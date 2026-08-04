import { describe, it, expect } from "vitest";
import { WorktreeManager, excludeOwnState, MAX_DIFF_CHARS } from "../../src/worktree/manager.js";
import type { GitRunner } from "../../src/worktree/git.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";

const session: WorktreeSession = { jobSlug: "j", root: "/x", baseWorktree: "/x/base", baseBranch: "hc/j/base" };

/** Answers each `git diff` from what its pathspecs ask for, and records the calls. */
function gitFor(parts: { code: string; docs: string }): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  const git = (async (args: string[]) => {
    calls.push(args);
    if (args[0] !== "diff") return { stdout: "", stderr: "", code: 0 };
    const wantsDocs = args.includes("*.md");
    return { stdout: wantsDocs ? parts.docs : parts.code, stderr: "", code: 0 };
  }) as GitRunner;
  return { calls, git };
}

const mgr = (git: GitRunner): WorktreeManager =>
  new WorktreeManager({ repoRoot: "/x", worktreeHome: "/x", runGit: git });

/**
 * The diff a reviewer is handed decides what gets reviewed, and it was handing over the wrong thing.
 *
 * Measured on PR #765. The full diff came to 70,673,949 characters; the 60,000 a reviewer was given held
 * exactly two files — `.gitignore` and `.horsecode/memory.jsonl` — and all 36 source files fell outside it.
 * The round that trusted what it was handed produced seven findings about memory-entry ID suffixes and
 * counter drift, and told the author the pull request "cannot be holistically reviewed".
 */
describe("what the reviewer is handed", () => {
  it("leaves horse-code's own state out of it", () => {
    const specs = excludeOwnState();
    expect(specs).toContain(":(exclude).horsecode/**");
    expect(specs).toContain(":(exclude)graphify-out/**");
    expect(specs.every((s) => s.startsWith(":(exclude)"))).toBe(true);
  });

  it("names no root twice, whatever the trace root is set to", () => {
    expect(new Set(excludeOwnState()).size).toBe(excludeOwnState().length);
  });

  /**
   * With the state excluded the window filled with specifications instead — nine files, all markdown, still
   * no code. Git orders by path, and work under `toucan/` sorts after every document a run writes.
   */
  it("puts the code before the prose written about it", async () => {
    const { git } = gitFor({ code: "CODE-DIFF\n", docs: "DOC-DIFF\n" });
    const out = await mgr(git).diff(session, "development");
    expect(out.indexOf("CODE-DIFF")).toBeLessThan(out.indexOf("DOC-DIFF"));
  });

  it("asks git for them separately, so neither can crowd the other out", async () => {
    const { calls, git } = gitFor({ code: "c", docs: "d" });
    await mgr(git).diff(session, "development");
    const diffs = calls.filter((a) => a[0] === "diff");
    expect(diffs.length).toBe(2);
    expect(diffs.some((a) => a.includes(":(exclude)*.md"))).toBe(true);
    expect(diffs.some((a) => a.includes("*.md") && !a.includes(":(exclude)*.md"))).toBe(true);
  });

  /** A ceiling that cannot fit one feature's source is a guarantee the source goes unread. */
  it("is large enough for a medium feature's code", () => {
    expect(MAX_DIFF_CHARS).toBeGreaterThanOrEqual(66_913);   // …measured: PR #765's code, documents excluded
  });

  it("keeps the code when the whole thing does not fit", async () => {
    const { git } = gitFor({ code: `CODE-HEAD\n${"c".repeat(MAX_DIFF_CHARS)}`, docs: "DOC-DIFF\n" });
    const out = await mgr(git).diff(session, "development");
    expect(out).toContain("CODE-HEAD");
    expect(out).not.toContain("DOC-DIFF");
  });

  /** Appended, the notice sits past where a truncated reader stops — so it says so at the top. */
  it("says it was truncated where the reader will see it", async () => {
    const { git } = gitFor({ code: "x".repeat(MAX_DIFF_CHARS + 5_000), docs: "" });
    const out = await mgr(git).diff(session, "development");
    expect(out.slice(0, 200)).toMatch(/truncated/i);
    expect(out.slice(0, 200)).toMatch(/read tools/i);
  });

  it("adds no notice at all when everything fits", async () => {
    const { git } = gitFor({ code: "small\n", docs: "also small\n" });
    expect(await mgr(git).diff(session, "development")).toBe("small\nalso small\n");
  });
});
