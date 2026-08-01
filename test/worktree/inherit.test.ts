import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inheritFromRoot, describeInherited, INHERITED_ASSETS } from "../../src/worktree/inherit.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});
const put = async (base: string, rel: string, body: string): Promise<void> => {
  await mkdir(join(base, rel, ".."), { recursive: true });
  await writeFile(join(base, rel), body, "utf8");
};

/**
 * A worktree cut from a branch has what was committed and nothing else — not the work in progress, and not
 * the state horse-code depends on, which on a real project was not in git at all (`.horsecode/` untracked,
 * `graphify-out/` never committed). The run must not read those from the root instead: the root is a
 * reference, and nothing written there reaches the pull request.
 */
describe("a new session inherits the project's working state", () => {
  it("carries uncommitted edits, deletions and untracked files", async () => {
    repo = await initTmpRepo();
    await put(repo, "kept.ts", "original\n");
    await put(repo, "gone.ts", "delete me\n");
    await defaultGitRunner(["add", "-A"], repo);
    await defaultGitRunner(["commit", "-m", "base"], repo);

    await put(repo, "kept.ts", "edited in the project\n");   // modified
    await rm(join(repo, "gone.ts"));                          // deleted
    await put(repo, "brand-new.ts", "never added\n");         // untracked

    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");

    expect(await readFile(join(s.baseWorktree, "kept.ts"), "utf8")).toBe("edited in the project\n");
    expect(existsSync(join(s.baseWorktree, "gone.ts"))).toBe(false);
    expect(await readFile(join(s.baseWorktree, "brand-new.ts"), "utf8")).toBe("never added\n");
  });

  it("carries the state git does not: graph, memory, skills, constitution", async () => {
    repo = await initTmpRepo();
    await put(repo, "graphify-out/graph.json", '{"nodes":[],"links":[]}');
    await put(repo, ".horsecode/memory.jsonl", '{"id":"m1","text":"a fact","anchors":[],"tags":[],"createdAt":1}\n');
    await put(repo, ".horsecode/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nbody");
    await put(repo, ".specify/memory/constitution.md", "# principles");
    await put(repo, ".gitignore", "graphify-out/\n.horsecode/\n.specify/\n");

    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");

    for (const rel of INHERITED_ASSETS) expect(existsSync(join(s.baseWorktree, rel)), rel).toBe(true);
    expect(await readFile(join(s.baseWorktree, ".horsecode", "skills", "impeccable", "SKILL.md"), "utf8"))
      .toContain("impeccable");
  });

  /** Copying the sessions directory into a session would copy that session into itself, and the next again. */
  it("never follows .horsecode/worktrees", async () => {
    repo = await initTmpRepo();
    await put(repo, ".horsecode/worktrees/older/base/file.ts", "a previous session\n");

    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");

    expect(existsSync(join(s.baseWorktree, ".horsecode", "worktrees"))).toBe(false);
  });

  it("says what it carried, and stays quiet when there was nothing", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const clean = await wm.openSession("main", "clean-job");
    expect(describeInherited(clean.inherited!)).toBeUndefined();

    await put(repo, "new.ts", "x");
    const s = await wm.openSession("main", "job2");
    expect(describeInherited(s.inherited!)).toContain("1 untracked file(s)");
  });

  it("is a no-op when asked to inherit into the root itself", async () => {
    repo = await initTmpRepo();
    const r = await inheritFromRoot(defaultGitRunner, repo, repo);
    expect(r).toEqual({ modified: [], untracked: [], assets: [], deleted: [], skipped: 0 });
  });
});

describe("inheritFromRoot — another checkout is not this project's work in progress", () => {
  /**
   * The measured failure: `git ls-files --others` reported 26,160 files under `.claude/`, nearly all inside
   * `worktrees.orphaned-backup/` — abandoned checkouts of the same repository, 29 GB. Every session copied
   * 22 GB of it before doing any work, and the session worktree ended up holding 321,367 files.
   */
  it("does not copy files that live inside a nested checkout", async () => {
    repo = await initTmpRepo();
    await put(repo, ".claude/worktrees.orphaned-backup/old-job/.git", "gitdir: /elsewhere");
    await put(repo, ".claude/worktrees.orphaned-backup/old-job/huge.ts", "another checkout's file");
    await put(repo, "real-wip.ts", "actual work in progress");

    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");

    expect(existsSync(join(s.baseWorktree, "real-wip.ts"))).toBe(true);
    expect(existsSync(join(s.baseWorktree, ".claude", "worktrees.orphaned-backup"))).toBe(false);
    expect(s.inherited?.skipped).toBeGreaterThan(0);
  });

  it("says what it left behind — a silent omission looks exactly like having nothing to carry", () => {
    expect(describeInherited({ modified: [], untracked: ["a.ts"], assets: [], deleted: [], skipped: 26_159 }))
      .toMatch(/26159 left behind/);
  });
});
