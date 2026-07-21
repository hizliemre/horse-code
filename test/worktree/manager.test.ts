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

  it("fresh repo, branch-name mismatch (real 'master', asked for 'main') → bootstraps + bases off HEAD", async () => {
    // Reproduces the reported crash: `git init` leaves an unborn 'master' HEAD, horse-code guesses 'main',
    // and `git worktree add … main` fails with "invalid reference: main". openSession must recover.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    repo = await mkdtemp(join(tmpdir(), "hc-fresh-"));
    const g = (args: string[]): Promise<{ code: number }> => defaultGitRunner(args, repo as string);
    await g(["init", "-b", "master"]); // real default branch is 'master', not 'main'
    await g(["config", "user.email", "test@hc.local"]);
    await g(["config", "user.name", "hc test"]);
    expect((await g(["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0); // no commits yet

    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "add-login-page"); // asked for 'main' (doesn't exist)
    expect(s.jobSlug).toBe("add-login-page");
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/add-login-page/base")).toBe(true);
    expect((await g(["rev-parse", "--verify", "--quiet", "HEAD"])).code).toBe(0); // bootstrap commit landed
  });

  it("bases off HEAD when the requested branch doesn't exist in a repo that already has commits", async () => {
    repo = await initTmpRepo(); // has a commit on 'main'
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("nonexistent-branch", "some-task"); // falls back to HEAD
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/some-task/base")).toBe(true);
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
