import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

// Edits README in the task worktree and commits it.
async function editAndCommit(worktree: string, content: string): Promise<void> {
  await writeFile(join(worktree, "README.md"), content, "utf8");
  await defaultGitRunner(["add", "-A"], worktree);
  await defaultGitRunner(["commit", "-m", "change"], worktree);
}

describe("WorktreeManager merge lifecycle", () => {
  it("conflict-free task merges into base (merged)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "a");
    await editAndCommit(t.worktree, "A\n");
    const res = await wm.mergeTask(s, t);
    expect(res.status).toBe("merged");
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("A\n");
  });

  it("two tasks editing the same file conflict on the second merge", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    expect((await wm.mergeTask(s, ta)).status).toBe("merged"); // ff
    const res = await wm.mergeTask(s, tb);
    expect(res).toEqual({ status: "conflict", files: ["README.md"] });
  });

  it("commitMerge completes a resolved conflict", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    await wm.mergeTask(s, ta);
    await wm.mergeTask(s, tb); // conflict
    await writeFile(join(s.baseWorktree, "README.md"), "RESOLVED\n", "utf8"); // simulating council resolution
    await wm.commitMerge(s);
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("RESOLVED\n");
    const status = await defaultGitRunner(["status", "--porcelain"], s.baseWorktree);
    expect(status.stdout.trim()).toBe(""); // clean, merge complete
  });

  it("abortMerge reverts the conflict (base is clean)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const ta = await wm.deriveTask(s, "a");
    const tb = await wm.deriveTask(s, "b");
    await editAndCommit(ta.worktree, "A\n");
    await editAndCommit(tb.worktree, "B\n");
    await wm.mergeTask(s, ta);
    await wm.mergeTask(s, tb); // conflict
    await wm.abortMerge(s);
    expect(await readFile(join(s.baseWorktree, "README.md"), "utf8")).toBe("A\n"); // ta's state
    const status = await defaultGitRunner(["status", "--porcelain"], s.baseWorktree);
    expect(status.stdout.trim()).toBe("");
  });

  it("commitMerge is a no-op when nothing is staged (does not throw, no new commit)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const before = (await defaultGitRunner(["rev-parse", "HEAD"], s.baseWorktree)).stdout.trim();
    await expect(wm.commitMerge(s, "empty")).resolves.toBeUndefined();
    const after = (await defaultGitRunner(["rev-parse", "HEAD"], s.baseWorktree)).stdout.trim();
    expect(after).toBe(before); // no new commit was created
  });
});
