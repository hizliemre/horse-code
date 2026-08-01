import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adoptClaudeWorktree, listClaudeWorktrees, describeAdoption, AdoptError, CLAUDE_WORKTREE_DIR } from "../../src/migrate/worktree.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

const git = defaultGitRunner;

/** A Claude-style worktree: `.claude/worktrees/<name>` on its own branch, with `commits` commits of work. */
async function claudeWorktree(root: string, name: string, branch: string, commits: string[]): Promise<string> {
  const path = join(root, CLAUDE_WORKTREE_DIR, name);
  await mkdir(join(root, CLAUDE_WORKTREE_DIR), { recursive: true });
  await git(["worktree", "add", "-b", branch, path], root);
  for (const [i, subject] of commits.entries()) {
    await writeFile(join(path, `f${i}.ts`), `export const x${i} = ${i};\n`, "utf8");
    await git(["add", "-A"], path);
    await git(["commit", "-m", subject], path);
  }
  return path;
}

describe("adopting a Claude Code worktree", () => {
  it("reads the branch and the commits it carries", async () => {
    repo = await initTmpRepo();
    await claudeWorktree(repo, "pcw-step-basics", "feature/pcw-step-basics", ["feat: step one", "feat: step two"]);

    const w = await adoptClaudeWorktree(git, repo, "pcw-step-basics", "main");

    expect(w.branch).toBe("feature/pcw-step-basics");
    expect(w.commits.map((c) => c.subject)).toEqual(["feat: step two", "feat: step one"]); // newest first
    expect(w.dirty).toEqual([]);
  });

  /**
   * The project this was written for holds forty plan documents, thirty-nine of them about something else.
   * Only what THIS branch changed is the note written for THIS work.
   */
  it("reports only the markdown this branch itself changed", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "docs-elsewhere.md"), "someone else's plan\n", "utf8");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "unrelated doc"], repo);
    const path = await claudeWorktree(repo, "w", "feature/w", ["feat: work"]);
    await writeFile(join(path, "PLAN.md"), "the plan for this work\n", "utf8");
    await git(["add", "-A"], path);
    await git(["commit", "-m", "docs: plan"], path);

    const w = await adoptClaudeWorktree(git, repo, "w", "main");

    expect(w.docs).toEqual(["PLAN.md"]);
  });

  /** The session is cut from the BRANCH, so uncommitted work does not come across — silence there is expensive. */
  it("flags uncommitted changes, which are not inherited", async () => {
    repo = await initTmpRepo();
    const path = await claudeWorktree(repo, "w", "feature/w", ["feat: work"]);
    await writeFile(join(path, "in-flight.ts"), "not committed\n", "utf8");

    const w = await adoptClaudeWorktree(git, repo, "w", "main");

    expect(w.dirty).toEqual(["in-flight.ts"]);
    expect(describeAdoption(w)).toContain("NOT inherited");
  });

  it("lists what IS available when the name does not match", async () => {
    repo = await initTmpRepo();
    await claudeWorktree(repo, "pcw-step-basics", "feature/a", ["feat: a"]);
    await claudeWorktree(repo, "desi-control", "feature/b", ["feat: b"]);

    await expect(adoptClaudeWorktree(git, repo, "typo", "main")).rejects.toThrow(AdoptError);
    try { await adoptClaudeWorktree(git, repo, "typo", "main"); }
    catch (e) { expect((e as AdoptError).available).toEqual(["desi-control", "pcw-step-basics"]); }
  });

  /**
   * A leftover directory from a removed worktree looks identical on disk. Adopting it would pin the session
   * to a branch git does not have checked out anywhere.
   */
  it("refuses a directory that is not a registered worktree", async () => {
    repo = await initTmpRepo();
    await mkdir(join(repo, CLAUDE_WORKTREE_DIR, "ghost"), { recursive: true });
    await expect(adoptClaudeWorktree(git, repo, "ghost", "main")).rejects.toThrow(/No git worktree named/);
  });

  it("refuses a detached worktree — there is no branch to continue from", async () => {
    repo = await initTmpRepo();
    const path = await claudeWorktree(repo, "w", "feature/w", ["feat: work"]);
    const head = (await git(["rev-parse", "HEAD"], path)).stdout.trim();
    await git(["checkout", "--detach", head], path);

    await expect(adoptClaudeWorktree(git, repo, "w", "main")).rejects.toThrow(/not on a branch/);
  });

  it("finds nothing in a project that has no Claude worktrees", async () => {
    repo = await initTmpRepo();
    expect(await listClaudeWorktrees(git, repo)).toEqual([]);
  });
});

describe("the handover summary", () => {
  it("says the other tool's worktree is left alone, and what the next step is", async () => {
    repo = await initTmpRepo();
    await claudeWorktree(repo, "w", "feature/w", ["feat: work"]);
    const text = describeAdoption(await adoptClaudeWorktree(git, repo, "w", "main"));
    expect(text).toContain("left untouched");
    expect(text).toContain("inherited rather than rewritten");
    expect(text).toContain("tell me what to work on next");
  });

  it("says so plainly when the branch has no work of its own", async () => {
    repo = await initTmpRepo();
    await claudeWorktree(repo, "w", "feature/w", []);
    expect(describeAdoption(await adoptClaudeWorktree(git, repo, "w", "main"))).toContain("even with the base");
  });
});
