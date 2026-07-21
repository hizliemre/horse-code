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

const session: WorktreeSession = { jobSlug: "j", root: "/r", baseWorktree: "/r/base", baseBranch: "hc/j/base" };

function mgrWithDiff(stdout: string): WorktreeManager {
  const runGit: GitRunner = async () => ({ code: 0, stdout, stderr: "" });
  return new WorktreeManager({ repoRoot: "/r", runGit });
}

describe("manager.diff size-cap", () => {
  it("kısa diff aynen döner", async () => {
    expect(await mgrWithDiff("kısa diff").diff(session, "main")).toBe("kısa diff");
  });

  it("uzun diff kesilir + kesme-notu eklenir", async () => {
    const long = "x".repeat(70_000);
    const out = await mgrWithDiff(long).diff(session, "main");
    expect(out.length).toBeLessThan(70_000);
    expect(out).toContain("diff kısaltıldı");
    expect(out).toContain("10000 karakter atlandı"); // 70000 - 60000
    expect(out.startsWith("x".repeat(100))).toBe(true); // baş korunur
  });
});
