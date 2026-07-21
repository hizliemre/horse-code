import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.diff", () => {
  it("base'e karşı baseBranch değişikliklerini unified diff'te verir", async () => {
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const s = await mgr.openSession("main", "job");
    await writeFile(join(s.baseWorktree, "yeni.txt"), "içerik\n", "utf8");
    const g = (args: string[]) => defaultGitRunner(args, s.baseWorktree);
    await g(["add", "-A"]);
    await g(["commit", "-m", "değişiklik"]);
    const d = await mgr.diff(s, "main");
    expect(d).toContain("yeni.txt");
    expect(d).toContain("içerik");
  });
});
