import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const r = await defaultGitRunner(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir);
  return r.code === 0;
}

describe("WorktreeManager.openSession", () => {
  it("creates the base worktree + hc/<slug>/base branch, writes .gitignore", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "Add Auth");
    expect(s.jobSlug).toBe("add-auth");
    expect(s.baseBranch).toBe("hc/add-auth/base");
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/add-auth/base")).toBe(true);
    expect(existsSync(join(repo, ".horsecode/worktrees/.gitignore"))).toBe(true);
  });

  it("same jobName a second time → deduped with slug -2", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const a = await wm.openSession("main", "job");
    const b = await wm.openSession("main", "job");
    expect(a.jobSlug).toBe("job");
    expect(b.jobSlug).toBe("job-2");
  });
});

describe("WorktreeManager.deriveTask", () => {
  it("creates a worktree derived from base + hc/<slug>/t/<task> branch", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "Create Model");
    expect(t.taskSlug).toBe("create-model");
    expect(t.branch).toBe("hc/job/t/create-model");
    expect(existsSync(t.worktree)).toBe(true);
    expect(await branchExists(repo, "hc/job/t/create-model")).toBe(true);
  });
});
