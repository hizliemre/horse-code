import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { surveySessions, cleanSessions, describeSurvey } from "../../src/worktree/clean.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
let mgr: WorktreeManager;
const g = (args: string[], cwd = repo) => defaultGitRunner(args, cwd);

beforeEach(async () => { repo = await initTmpRepo(); mgr = new WorktreeManager({ repoRoot: repo }); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/** A session that committed one file on its base branch, and nothing else. */
async function session(name: string, file = `${name}.ts`): Promise<{ slug: string; root: string; base: string }> {
  const s = await mgr.openSession("main", name);
  await writeFile(join(s.baseWorktree, file), `// ${name}\n`, "utf8");
  await g(["add", "-A"], s.baseWorktree);
  await g(["commit", "-m", `work for ${name}`], s.baseWorktree);
  return { slug: s.jobSlug, root: s.root, base: s.baseBranch };
}

const verdictOf = async (slug: string, target = "main"): Promise<string> =>
  (await surveySessions(defaultGitRunner, repo, target)).find((s) => s.slug === slug)!.verdict;

describe("what may be removed", () => {
  it("removes a session whose work is in the target branch, directory and branches together", async () => {
    const s = await session("done");
    await g(["merge", "--no-ff", "-m", "merge", s.base]);

    expect(await verdictOf(s.slug)).toBe("merged");
    const res = await cleanSessions(defaultGitRunner, repo, "main");
    expect(res.removed).toEqual([s.slug]);
    expect(existsSync(s.root)).toBe(false);                                   // the directory is gone
    expect((await g(["branch", "--list", `${s.base}`])).stdout.trim()).toBe(""); // …and so is the branch
    expect((await g(["worktree", "list"])).stdout).not.toContain(s.root);      // …and git no longer lists it
  });

  it("removes the task worktrees under it, not only the base", async () => {
    const s = await mgr.openSession("main", "with tasks");
    const t = await mgr.deriveTask(s, "a task");
    await writeFile(join(t.worktree, "x.ts"), "x\n", "utf8");
    await mgr.commitTask(t, "task work");
    await mgr.mergeTask(s, t);
    await g(["merge", "--no-ff", "-m", "merge", s.baseBranch]);

    await cleanSessions(defaultGitRunner, repo, "main");
    expect(existsSync(t.worktree)).toBe(false);
    expect((await g(["branch", "--list", "hc/*"])).stdout.trim()).toBe("");
  });

  /**
   * The case that decides whether this command is useful at all.
   *
   * A pull request platform that squash-merges (Azure DevOps does by default) puts ONE commit on the target
   * with a different hash and a different patch id from every commit on the branch. The branch is therefore
   * not an ancestor of the target and `git branch --merged` never lists it — so a command that only tests
   * ancestry does nothing, forever, on exactly the workflow that produces the most dead worktrees.
   */
  it("recognises work that reached the target as a single squashed commit", async () => {
    const s = await mgr.openSession("main", "squashed");
    await writeFile(join(s.baseWorktree, "a.ts"), "one\n", "utf8");
    await g(["add", "-A"], s.baseWorktree);
    await g(["commit", "-m", "first"], s.baseWorktree);
    await writeFile(join(s.baseWorktree, "b.ts"), "two\n", "utf8");
    await g(["add", "-A"], s.baseWorktree);
    await g(["commit", "-m", "second"], s.baseWorktree);

    await g(["merge", "--squash", s.baseBranch]);
    await g(["commit", "-m", "squashed the whole branch"]);
    // Proof that the ordinary test is blind to this, so the assertion below is about the squash detection.
    expect((await g(["merge-base", "--is-ancestor", s.baseBranch, "main"])).code).not.toBe(0);

    expect(await verdictOf(s.jobSlug)).toBe("merged");
  });

  it("treats a session that added nothing as merged — there is nothing in it to lose", async () => {
    const s = await mgr.openSession("main", "empty");
    expect(await verdictOf(s.jobSlug)).toBe("merged");
  });
});

describe("what must survive", () => {
  it("keeps a session whose work has not landed", async () => {
    const s = await session("live");
    expect(await verdictOf(s.slug)).toBe("unmerged");
    const res = await cleanSessions(defaultGitRunner, repo, "main");
    expect(res.removed).toEqual([]);
    expect(existsSync(s.root)).toBe(true);
  });

  /**
   * Merged says the COMMITS are safe; it says nothing about the file someone is editing. Measured on a real
   * project, the base worktree of a finished session held nine uncommitted changes.
   */
  it("keeps a merged session that still has uncommitted changes, and says which", async () => {
    const s = await session("dirty");
    await g(["merge", "--no-ff", "-m", "merge", s.base]);
    await writeFile(join(s.root, "base", "scratch.txt"), "not committed\n", "utf8");

    const survey = await surveySessions(defaultGitRunner, repo, "main");
    const row = survey.find((x) => x.slug === s.slug)!;
    expect(row.verdict).toBe("dirty");
    expect(row.detail).toMatch(/uncommitted/i);
    expect((await cleanSessions(defaultGitRunner, repo, "main")).removed).toEqual([]);
    expect(existsSync(s.root)).toBe(true);
  });

  it("sees uncommitted work in a TASK worktree, not only in the base", async () => {
    const s = await mgr.openSession("main", "dirty task");
    const t = await mgr.deriveTask(s, "a task");
    await g(["merge", "--no-ff", "--allow-unrelated-histories", "-m", "merge", s.baseBranch]).catch(() => undefined);
    await writeFile(join(t.worktree, "scratch.txt"), "not committed\n", "utf8");
    expect(await verdictOf(s.jobSlug)).toBe("dirty");
  });

  /** Another tool's checkouts are not this command's to remove, whatever state they are in. */
  it("never looks outside .horsecode/worktrees", async () => {
    await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
    await g(["worktree", "add", "-b", "feature/theirs", join(repo, ".claude", "worktrees", "theirs"), "main"]);
    await g(["merge", "--no-ff", "-m", "merge", "feature/theirs"]);

    const survey = await surveySessions(defaultGitRunner, repo, "main");
    expect(survey.map((s) => s.slug)).not.toContain("theirs");
    await cleanSessions(defaultGitRunner, repo, "main");
    expect(existsSync(join(repo, ".claude", "worktrees", "theirs"))).toBe(true);
  });

  /**
   * A directory git no longer knows about is stale, not merged — its branch may be gone with the record of
   * what it held. Reported so the user can see it; never removed, because "I cannot tell what this was" is
   * not a reason to delete someone's files.
   */
  it("reports a directory git has lost track of, and leaves it alone", async () => {
    const orphan = join(repo, ".horsecode", "worktrees", "left-behind");
    await mkdir(join(orphan, "base"), { recursive: true });
    await writeFile(join(orphan, "base", "something.ts"), "x\n", "utf8");

    const row = (await surveySessions(defaultGitRunner, repo, "main")).find((s) => s.slug === "left-behind")!;
    expect(row.verdict).toBe("orphan");
    await cleanSessions(defaultGitRunner, repo, "main");
    expect(existsSync(orphan)).toBe(true);
  });

  it("says nothing is there rather than failing on a project that never ran a session", async () => {
    expect(await surveySessions(defaultGitRunner, repo, "main")).toEqual([]);
    expect(describeSurvey([], "main")).toMatch(/no horse-code worktrees/i);
  });
});

describe("what the user is told before anything is deleted", () => {
  it("names every session, its verdict and the reason", async () => {
    const done = await session("finished");
    await g(["merge", "--no-ff", "-m", "merge", done.base]);
    await session("ongoing");

    const text = describeSurvey(await surveySessions(defaultGitRunner, repo, "main"), "main");
    expect(text).toContain(done.slug);
    expect(text).toContain("ongoing");
    expect(text).toMatch(/main/);                       // the branch it judged against — never left implicit
    expect(text).toMatch(/clean-worktrees go/);          // …and how to actually do it
  });

  it("does not offer the removal step when there is nothing to remove", async () => {
    await session("ongoing");
    const text = describeSurvey(await surveySessions(defaultGitRunner, repo, "main"), "main");
    expect(text).not.toMatch(/clean-worktrees go/);
  });
});
