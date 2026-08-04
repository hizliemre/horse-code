import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { mainWorktreeRoot } from "../../src/worktree/manager.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
const g = (args: string[], cwd = repo) => defaultGitRunner(args, cwd);
beforeEach(async () => { repo = await initTmpRepo(); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/**
 * A session belongs to the REPOSITORY, not to whichever checkout of it you happened to be standing in.
 *
 * Measured from a live run: horse-code was started inside another tool's worktree and opened its session at
 * `…/.claude/worktrees/product-create-wizard/.horsecode/worktrees/…/base` — a horse-code worktree nested
 * inside a Claude Code worktree inside the repository. It works, and it is a place nobody will look, that
 * `/clean-worktrees` at the repository root cannot see, and that disappears if the outer checkout is removed.
 */
describe("where a session's worktree is put", () => {
  it("finds the repository's main checkout from inside a linked worktree", async () => {
    const linked = join(repo, "..", `linked-${Date.now()}`);
    try {
      await g(["worktree", "add", "-b", "side", linked, "main"]);
      // Compared through realpath: git answers with the canonical path, and on macOS /var is a symlink.
      expect(realpathSync(await mainWorktreeRoot(defaultGitRunner, linked))).toBe(realpathSync(repo));
      expect(realpathSync(await mainWorktreeRoot(defaultGitRunner, repo))).toBe(realpathSync(repo)); // no-op from the main one
    } finally {
      await g(["worktree", "remove", "--force", linked]).catch(() => undefined);
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("stays where it is when the directory is not a repository at all", async () => {
    const plain = join(repo, "..", `plain-${Date.now()}`);
    await mkdir(plain, { recursive: true });
    try {
      expect(await mainWorktreeRoot(defaultGitRunner, plain)).toBe(plain);
    } finally { await rm(plain, { recursive: true, force: true }); }
  });

  /**
   * The state a session inherits still comes from where the USER is: their code graph, their memory, their
   * project config are in the checkout they are standing in, not in the main one.
   */
  it("opens the session in the main checkout while inheriting from the one you are in", async () => {
    const linked = join(repo, "..", `linked2-${Date.now()}`);
    try {
      await g(["worktree", "add", "-b", "side2", linked, "main"]);
      await mkdir(join(linked, ".horsecode"), { recursive: true });
      await writeFile(join(linked, ".horsecode", "memory.jsonl"),
        '{"id":"m1","text":"only in the linked checkout","anchors":[],"tags":[],"createdAt":1}\n', "utf8");

      const mgr = new WorktreeManager({ repoRoot: linked, worktreeHome: await mainWorktreeRoot(defaultGitRunner, linked) });
      const s = await mgr.openSession("side2", "job");

      // The session lives in the repository's own .horsecode, not inside the linked checkout.
      expect(realpathSync(s.root).startsWith(realpathSync(join(repo, ".horsecode", "worktrees")))).toBe(true);
      expect(s.root.includes(".claude")).toBe(false);
      expect(existsSync(join(linked, ".horsecode", "worktrees"))).toBe(false);
      // …and it still carries the state that was only in the checkout the user was standing in.
      expect(existsSync(join(s.baseWorktree, ".horsecode", "memory.jsonl"))).toBe(true);
    } finally {
      await g(["worktree", "remove", "--force", linked]).catch(() => undefined);
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("keeps putting sessions in the same place when there is only one checkout", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, worktreeHome: repo });
    const s = await mgr.openSession("main", "job");
    expect(realpathSync(s.root).startsWith(realpathSync(join(repo, ".horsecode", "worktrees")))).toBe(true);
  });
});
