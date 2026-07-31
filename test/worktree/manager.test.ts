import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
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
    // "Add Auth" → "auth": the name is the subject, and the verb is what the tool always does.
    const s = await wm.openSession("main", "Add Auth");
    expect(s.jobSlug).toBe("auth");
    expect(s.baseBranch).toBe("hc/auth/base");
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/auth/base")).toBe(true);
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

  it("branch lingers but the worktree dir is gone → deduped (no 'branch already exists' crash)", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const a = await wm.openSession("main", "job");
    expect(a.jobSlug).toBe("job");
    // Remove the worktree dir but KEEP the branch (simulates a cleaned .horsecode/worktrees).
    await defaultGitRunner(["worktree", "remove", "--force", a.baseWorktree], repo);
    expect(existsSync(a.baseWorktree)).toBe(false);
    expect(await branchExists(repo, "hc/job/base")).toBe(true); // branch still lingering
    const b = await wm.openSession("main", "job"); // must skip the lingering branch, not crash
    expect(b.jobSlug).toBe("job-2");
    expect(await branchExists(repo, "hc/job-2/base")).toBe(true);
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
    const s = await wm.openSession("main", "login-page"); // asked for 'main' (doesn't exist)
    expect(s.jobSlug).toBe("login-page");
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/login-page/base")).toBe(true);
    expect((await g(["rev-parse", "--verify", "--quiet", "HEAD"])).code).toBe(0); // bootstrap commit landed
  });

  it("auto `git init`s a non-git directory (the user hasn't run git init)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    repo = await mkdtemp(join(tmpdir(), "hc-nogit-")); // a PLAIN dir — not a git repo
    expect((await defaultGitRunner(["rev-parse", "--is-inside-work-tree"], repo)).code).not.toBe(0);
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "fresh-task"); // must init + bootstrap + create the worktree
    expect((await defaultGitRunner(["rev-parse", "--is-inside-work-tree"], repo)).stdout.trim()).toBe("true"); // now a repo
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/fresh-task/base")).toBe(true);
  });

  it("bases off HEAD when the requested branch doesn't exist in a repo that already has commits", async () => {
    repo = await initTmpRepo(); // has a commit on 'main'
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("nonexistent-branch", "some-task"); // falls back to HEAD
    expect(existsSync(s.baseWorktree)).toBe(true);
    expect(await branchExists(repo, "hc/some-task/base")).toBe(true);
  });
});

describe("WorktreeManager.preserveSession (rejection)", () => {
  it("commits the draft AND keeps the worktree dir + branch (user can inspect the files directly)", async () => {
    const { writeFile } = await import("node:fs/promises");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "reject-me");
    await writeFile(join(s.baseWorktree, "spec.md"), "# rejected draft", "utf8"); // uncommitted draft
    const dir = await wm.preserveSession(s, "hc: rejected spec draft");
    expect(dir).toBe(s.baseWorktree);
    expect(existsSync(join(s.baseWorktree, "spec.md"))).toBe(true); // worktree dir + files KEPT for inspection
    expect(await branchExists(repo, "hc/reject-me/base")).toBe(true); // branch survives
    // the draft is also committed on the branch (nothing left uncommitted)
    expect((await defaultGitRunner(["status", "--porcelain"], s.baseWorktree)).stdout.trim()).toBe("");
    expect((await defaultGitRunner(["show", "hc/reject-me/base:spec.md"], repo)).stdout).toContain("# rejected draft");
  });
});

describe("WorktreeManager.findResumable", () => {
  it("returns the preserved session when a checkpoint matches the prompt (case/space-tolerant)", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "todo-app");
    writeCheckpoint(s.root, { rawPrompt: "Build a todo app", refinedPrompt: "x", title: "Todo App", language: "English", featureSlug: "001-todo-app", done: ["constitution", "spec"] });
    const found = await wm.findResumable("  build A todo APP "); // retyped, different case/spacing
    expect(found?.jobSlug).toBe("todo-app");
    expect(found?.baseWorktree).toBe(s.baseWorktree);
    expect(found?.resumed).toBe(true);
  });

  it("a bare 'continue' request resumes the MOST RECENTLY touched worktree (no exact prompt needed)", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const older = await wm.openSession("main", "old-task");
    writeCheckpoint(older.root, { rawPrompt: "build the old thing", refinedPrompt: "x", title: "Old", language: "English", featureSlug: "001-old", done: ["spec"] });
    await new Promise((r) => setTimeout(r, 15)); // ensure a later mtime on the newer checkpoint
    const newer = await wm.openSession("main", "recent-task");
    writeCheckpoint(newer.root, { rawPrompt: "build the new thing", refinedPrompt: "y", title: "New", language: "Turkish", featureSlug: "001-new", done: ["constitution"] });
    const found = await wm.findResumable("kaldığımız yerden devam edelim"); // matches neither prompt, but is a continue
    expect(found?.jobSlug).toBe("recent-task"); // most recent wins — both have progress
  });

  // Observed in the wild: a mis-resume scaffolded an empty worktree, which then outranked a spec'd, committed
  // feature purely because it was newer — so "continue" restarted the pipeline from the constitution.
  it("prefers work that has ACTUAL PROGRESS over a newer worktree that finished nothing", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const real = await wm.openSession("main", "real-work");
    writeCheckpoint(real.root, { rawPrompt: "build the todo app", refinedPrompt: "x", title: "Real", language: "Turkish", featureSlug: "001-real", done: ["constitution", "spec", "clarify"] });
    await new Promise((r) => setTimeout(r, 15));
    const empty = await wm.openSession("main", "empty-shell");
    writeCheckpoint(empty.root, { rawPrompt: "devam et", refinedPrompt: "y", title: "Empty", language: "Turkish", featureSlug: "001-empty", done: [] });
    expect((await wm.findResumable("devam et"))?.jobSlug).toBe("real-work");
  });

  it("still falls back to recency when NEITHER has progress", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const older = await wm.openSession("main", "old-empty");
    writeCheckpoint(older.root, { rawPrompt: "a", refinedPrompt: "x", title: "A", language: "English", featureSlug: "001-a", done: [] });
    await new Promise((r) => setTimeout(r, 15));
    const newer = await wm.openSession("main", "new-empty");
    writeCheckpoint(newer.root, { rawPrompt: "b", refinedPrompt: "y", title: "B", language: "English", featureSlug: "001-b", done: [] });
    expect((await wm.findResumable("devam"))?.jobSlug).toBe("new-empty");
  });

  it("returns null when no checkpoint matches (fresh session)", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "todo-app");
    writeCheckpoint(s.root, { rawPrompt: "Build a todo app", refinedPrompt: "x", title: "Todo App", language: "English", featureSlug: "001-todo-app", done: [] });
    expect(await wm.findResumable("Build a chat app")).toBeNull(); // different prompt
  });

  it("ignores a checkpoint whose worktree git no longer tracks (stale dir, unsafe to reuse)", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "todo-app");
    writeCheckpoint(s.root, { rawPrompt: "Build a todo app", refinedPrompt: "x", title: "Todo App", language: "English", featureSlug: "001-todo-app", done: ["spec"] });
    // Detach the worktree from git but leave the dir + checkpoint on disk.
    await defaultGitRunner(["worktree", "remove", "--force", s.baseWorktree], repo);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(s.baseWorktree, { recursive: true });
    writeCheckpoint(s.root, { rawPrompt: "Build a todo app", refinedPrompt: "x", title: "Todo App", language: "English", featureSlug: "001-todo-app", done: ["spec"] });
    await writeFile(join(s.root, "keep.txt"), "x", "utf8");
    expect(await wm.findResumable("Build a todo app")).toBeNull(); // not git-tracked → skipped
  });
});

describe("WorktreeManager.deriveTask", () => {
  it("creates a worktree derived from base + hc/<slug>/t/<task> branch", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    const t = await wm.deriveTask(s, "Create Model");
    expect(t.taskSlug).toBe("model");
    expect(t.branch).toBe("hc/job/t/model");
    expect(existsSync(t.worktree)).toBe(true);
    expect(await branchExists(repo, "hc/job/t/model")).toBe(true);
  });
});

/**
 * A task's worktree used to be minted fresh every time, so a task got `…-1`, `…-2`, `…-9`, and each run began
 * from base with the previous run's work stranded in a directory nobody would open again.
 *
 * Measured live: 321 worktrees on disk, TEN of them for one task, and the newest empty while `…-9` held 8
 * commits and 7.6 KB of finished work. It also made the pipeline lie — the deadline warning tells the
 * implementer "whatever it wrote is committed and kept, continue from there", and across runs that was false.
 */
/**
 * Reuse fixed the "start from scratch every run" waste, but it also FROZE the branch's root.
 *
 * Measured on a real board: the reused export/import branch was rooted two and a half days back with the base
 * 68 commits past it, while the throwaway worktrees it replaced had been rooted 29-30 commits back. The task
 * passed review twice and never landed — its merge had to reconcile that drift across seven files, and the
 * resolver ran out of turns every time. Retiring the branch is what puts the next attempt back on today's base.
 */
describe("restartTask re-roots a task on the current base", () => {
  it("retires the old branch and derives the next attempt from where base is NOW", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const first = await mgr.deriveTask(session, "Wire the store");
      const rootedAt = (await defaultGitRunner(["merge-base", first.branch, session.baseBranch], repo)).stdout.trim();

      // The base moves on, as it does while a task spends attempts failing.
      await writeFile(join(session.baseWorktree, "moved.txt"), "the world moved on", "utf8");
      await defaultGitRunner(["add", "-A"], session.baseWorktree);
      await defaultGitRunner(["commit", "-m", "base moves on"], session.baseWorktree);
      const movedTo = (await defaultGitRunner(["rev-parse", "HEAD"], session.baseWorktree)).stdout.trim();
      expect(movedTo).not.toBe(rootedAt);

      const retired = await mgr.restartTask(session, first);
      expect(retired).toBe("hc/job/t/wire-the-store-stale");
      expect(await branchExists(repo, retired)).toBe(true);      // the reviewed work is KEPT, not deleted
      expect(await branchExists(repo, first.branch)).toBe(false); // …and the name is free again
      expect(existsSync(first.worktree)).toBe(false);

      const second = await mgr.deriveTask(session, "Wire the store");
      expect(second.branch).toBe(first.branch); // same name, new history
      const newRoot = (await defaultGitRunner(["merge-base", second.branch, session.baseBranch], repo)).stdout.trim();
      expect(newRoot).toBe(movedTo); // rooted on today's base — the drift that made the merge unresolvable is gone
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("keeps every retired attempt rather than overwriting the last one", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const a = await mgr.deriveTask(session, "Wire the store");
      expect(await mgr.restartTask(session, a)).toBe("hc/job/t/wire-the-store-stale");
      const b = await mgr.deriveTask(session, "Wire the store");
      expect(await mgr.restartTask(session, b)).toBe("hc/job/t/wire-the-store-stale-2");
      expect(await branchExists(repo, "hc/job/t/wire-the-store-stale")).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

describe("deriveTask reuses a task's worktree", () => {
  it("returns the same worktree and branch the second time", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const a = await mgr.deriveTask(session, "Wire the store");
      const b = await mgr.deriveTask(session, "Wire the store");
      expect(b.worktree).toBe(a.worktree);
      expect(b.branch).toBe(a.branch);
      expect(b.taskSlug).toBe(a.taskSlug);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** The whole point: work from the earlier run is still there. */
  it("keeps the work the first run committed", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const first = await mgr.deriveTask(session, "Add the store");
      await writeFile(join(first.worktree, "store.ts"), "export const store = 1;\n");
      await defaultGitRunner(["add", "-A"], first.worktree);
      await defaultGitRunner(["commit", "-m", "wip"], first.worktree);
      const again = await mgr.deriveTask(session, "Add the store");
      expect(existsSync(join(again.worktree, "store.ts"))).toBe(true);
      const log = await defaultGitRunner(["log", "--oneline"], again.worktree);
      expect(log.stdout).toContain("wip");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** Two DIFFERENT tasks still get their own, even when their titles slugify close to each other. */
  it("gives different tasks different worktrees", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const a = await mgr.deriveTask(session, "Add the store");
      const b = await mgr.deriveTask(session, "Add the router");
      expect(b.worktree).not.toBe(a.worktree);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** A leftover directory that is not this branch's worktree must not stop the task. */
  it("mints a fresh slug when the existing path is not a usable worktree", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      await mkdir(join(session.root, "tasks", "add-the-store"), { recursive: true });
      const t = await mgr.deriveTask(session, "Add the store");
      expect(t.taskSlug).not.toBe("add-the-store");
      expect(existsSync(join(t.worktree, ".git"))).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
