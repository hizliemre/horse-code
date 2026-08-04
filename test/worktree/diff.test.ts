import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager, MAX_DIFF_CHARS, type WorktreeSession } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { GitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.diff", () => {
  it("returns baseBranch changes against base as a unified diff", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    await writeFile(join(s.baseWorktree, "new.txt"), "content\n", "utf8");
    const g = (args: string[]) => defaultGitRunner(args, s.baseWorktree);
    await g(["add", "-A"]);
    await g(["commit", "-m", "change"]);
    const d = await mgr.diff(s, "main");
    expect(d).toContain("new.txt");
    expect(d).toContain("content");
  });
});

const session: WorktreeSession = { jobSlug: "j", root: "/r", baseWorktree: "/r/base", baseBranch: "hc/j/base" };

/** The code pass answers with `stdout`; the documents pass answers with nothing, so the size is the code's. */
function mgrWithDiff(stdout: string): WorktreeManager {
  const runGit: GitRunner = async (args) => ({ code: 0, stdout: args.includes("*.md") ? "" : stdout, stderr: "" });
  return new WorktreeManager({ repoRoot: "/r", runGit });
}

describe("manager.diff size-cap", () => {
  it("short diff is returned unchanged", async () => {
    expect(await mgrWithDiff("short diff").diff(session, "main")).toBe("short diff");
  });

  /**
   * The notice moved to the FRONT, and the ceiling went up.
   *
   * Appended, it sat past where a truncated reader stops — so a cut diff read as a whole one. And 60,000 was
   * measured too small to hold one feature's source: PR #765's code came to 66,913 characters with every
   * document excluded. See test/worktree/pr-diff.test.ts for what that cost.
   */
  it("long diff is cut, and says so where the reader will see it", async () => {
    const long = "x".repeat(MAX_DIFF_CHARS + 10_000);
    const out = await mgrWithDiff(long).diff(session, "main");
    expect(out.length).toBeLessThan(MAX_DIFF_CHARS + 500);
    expect(out.slice(0, 200)).toContain("truncated");
    expect(out.slice(0, 200)).toContain(String(MAX_DIFF_CHARS + 10_000)); // …the size it was cut FROM
    expect(out).toContain("x".repeat(100));                                // …and the diff itself follows
  });
});
