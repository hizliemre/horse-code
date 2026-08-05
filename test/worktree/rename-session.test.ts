import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await initTmpRepo(); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

const mgr = (): WorktreeManager => new WorktreeManager({ repoRoot: repo });

/**
 * A session is named from the FIRST request that needed a worktree, and the first request is often the
 * smallest.
 *
 * Reported live: a sitting whose real work was product-upload testing sat in
 * `hc/turkish-agent-communications/base` — named after a one-line rule someone asked for on the way in. The
 * name is what a person reads in `git worktree list` a week later, so it should describe the work, not the
 * doorway.
 */
describe("renaming a session to what the work turned out to be", () => {
  it("moves the worktree and the branch together", async () => {
    const m = mgr();
    const s = await m.openSession("main", "turkish agent communications");
    const r = await m.renameSession(s, "product upload testing");

    expect(r.jobSlug).toBe("product-upload-testing");
    expect(r.baseBranch).toBe("hc/product-upload-testing/base");
    expect(existsSync(r.baseWorktree)).toBe(true);
    expect(existsSync(s.baseWorktree)).toBe(false);
    const branches = await defaultGitRunner(["for-each-ref", "--format=%(refname:short)", "refs/heads/hc/"], repo);
    expect(branches.stdout).toContain("hc/product-upload-testing/base");
    expect(branches.stdout).not.toContain("hc/turkish-agent-communications/base");
  });

  /** The session directory carries more than the checkout: the board, the checkpoint, the task worktrees. */
  it("takes the session's own files with it", async () => {
    const m = mgr();
    const s = await m.openSession("main", "first guess");
    await writeFile(join(s.root, "board.json"), '{"cards":[]}', "utf8");
    await writeFile(join(s.root, "checkpoint.json"), '{"rawPrompt":"x"}', "utf8");
    const r = await m.renameSession(s, "the real work");
    expect(existsSync(join(r.root, "board.json"))).toBe(true);
    expect(existsSync(join(r.root, "checkpoint.json"))).toBe(true);
    expect(existsSync(s.root)).toBe(false);
  });

  it("does nothing when the name has not changed", async () => {
    const m = mgr();
    const s = await m.openSession("main", "same name");
    expect(await m.renameSession(s, "same name")).toEqual(s);
    expect(await m.renameSession(s, "  ")).toEqual(s);
  });

  /** A name someone else is using is not free to take. */
  it("leaves the session alone when the target is taken", async () => {
    const m = mgr();
    const taken = await m.openSession("main", "already here");
    const s = await m.openSession("main", "second");
    expect(await m.renameSession(s, "already here")).toEqual(s);
    expect(existsSync(taken.baseWorktree)).toBe(true);
  });

  /**
   * A pushed branch keeps its name: renaming it would orphan whatever was cut from it, and a pull request
   * points at a branch by name.
   */
  it("refuses once the branch has a remote", async () => {
    const m = mgr();
    const s = await m.openSession("main", "before publishing");
    // Give the branch an upstream, the way a push does.
    const bare = join(repo, "..", `remote-${Date.now()}.git`);
    await mkdir(bare, { recursive: true });
    await defaultGitRunner(["init", "--bare", "-q"], bare);
    await defaultGitRunner(["remote", "add", "origin", bare], repo);
    await defaultGitRunner(["push", "-q", "-u", "origin", s.baseBranch], s.baseWorktree);
    try {
      expect(await m.renameSession(s, "after publishing")).toEqual(s);
    } finally { await rm(bare, { recursive: true, force: true }); }
  });
});

/** The rename happens where a continuing session is picked up, before anything is told where it is. */
describe("when the rename happens", () => {
  it("is before the session is adopted, so nothing holds the old path", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/job.ts", "utf8");
    const at = src.indexOf("opts.continueIn && existsSync");
    const block = src.slice(at, at + 1400);
    expect(block).toContain("deps.manager.renameSession(opts.continueIn, nameHint)");
    expect(block.indexOf("renameSession")).toBeLessThan(block.indexOf("adopt(renamed)"));
  });

  it("says so when it renames", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/job.ts", "utf8");
    const at = src.indexOf("opts.continueIn && existsSync");
    expect(src.slice(at, at + 1400)).toMatch(/Renamed this session to/);
  });
});

/**
 * Moving a worktree out from under a running process does not fail — it succeeds, and the process keeps a
 * handle on a path that no longer exists.
 *
 * That is the exact way these worktrees are meant to be used: run the project inside one, look at the
 * screen, ask for a change. If the change request renamed the directory, the file watcher would stop seeing
 * edits and hot reload would stop firing, with nothing on screen to say why. A better name is not worth it.
 */
describe("a worktree someone is working in", () => {
  it("is left where it is", async () => {
    const { busyInside } = await import("../../src/worktree/manager.js");
    const m = mgr();
    const s = await m.openSession("main", "before");
    // A process whose current directory is inside the worktree — a dev server, a test runner, a shell.
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { cwd: s.baseWorktree, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(busyInside(s.baseWorktree)).toBe(true);
      expect(await m.renameSession(s, "after")).toEqual(s);
    } finally { child.kill(); }
  });

  it("sees an idle one as idle", async () => {
    const { busyInside } = await import("../../src/worktree/manager.js");
    const m = mgr();
    const s = await m.openSession("main", "idle session");
    expect(busyInside(s.baseWorktree)).toBe(false);
  });

  /** Without an answer there is no way to tell, and the safe answer is the one that changes nothing. */
  it("treats an unanswerable question as busy", async () => {
    const { busyInside } = await import("../../src/worktree/manager.js");
    expect(busyInside("/no/such/directory/anywhere")).toBe(true);
  });
});
