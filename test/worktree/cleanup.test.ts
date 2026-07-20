import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

describe("WorktreeManager cleanup", () => {
  it("removeTask task worktree'sini ve branch'ini kaldırır", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "a");
    await wm.removeTask(s, t);
    expect(existsSync(t.worktree)).toBe(false);
    expect(await branchExists(repo, t.branch)).toBe(false);
  });

  it("closeSession tüm worktree'leri ve session branch'lerini temizler", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    await wm.deriveTask(s, "a"); // temizlenmeden bırakılan task
    await wm.closeSession(s);
    expect(existsSync(s.root)).toBe(false);
    expect(await branchExists(repo, s.baseBranch)).toBe(false);
    expect(await branchExists(repo, "hc/job/t/a")).toBe(false);
    const list = await defaultGitRunner(["worktree", "list", "--porcelain"], repo);
    expect(list.stdout).not.toContain("hc/job");
  });
});
