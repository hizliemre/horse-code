import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.commitTask", () => {
  it("commits task worktree changes to the task branch", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    const tw = await mgr.deriveTask(s, "task a");
    await writeFile(join(tw.worktree, "a.txt"), "hi", "utf8");
    await mgr.commitTask(tw, "hc: task a");
    const log = await defaultGitRunner(["log", "--oneline", tw.branch], repo);
    expect(log.stdout).toContain("hc: task a");
  });

  it("no-op when there are no changes (no error, no new commit)", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    const tw = await mgr.deriveTask(s, "task b");
    await mgr.commitTask(tw, "hc: task b"); // no changes at all
    const log = await defaultGitRunner(["log", "--oneline", tw.branch], repo);
    expect(log.stdout).not.toContain("hc: task b");
  });
});
