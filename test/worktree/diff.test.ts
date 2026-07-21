import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager, type WorktreeSession } from "../../src/worktree/manager.js";
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

function mgrWithDiff(stdout: string): WorktreeManager {
  const runGit: GitRunner = async () => ({ code: 0, stdout, stderr: "" });
  return new WorktreeManager({ repoRoot: "/r", runGit });
}

describe("manager.diff size-cap", () => {
  it("short diff is returned unchanged", async () => {
    expect(await mgrWithDiff("short diff").diff(session, "main")).toBe("short diff");
  });

  it("long diff gets truncated + truncation note appended", async () => {
    const long = "x".repeat(70_000);
    const out = await mgrWithDiff(long).diff(session, "main");
    expect(out.length).toBeLessThan(70_000);
    expect(out).toContain("diff truncated");
    expect(out).toContain("10000 characters omitted"); // 70000 - 60000
    expect(out.startsWith("x".repeat(100))).toBe(true); // start is preserved
  });
});
