import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager, guardRoot, FORBIDDEN_AT_ROOT } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";

/**
 * The pipeline's first rule, enforced instead of documented.
 *
 * Reported from a live run against a real project: a session's work was merged into the checkout's own
 * `development` branch, and the user had to undo it by hand. The rule — a run never writes to the checkout
 * you are working in — was in the README and in the discipline of every call site, and one call site did it
 * anyway, deliberately, as a feature: with no remote to open a pull request against, `deliverLocally` merged
 * on the user's behalf.
 *
 * The capability is gone, and this is what stops it returning by another route. A guard written at each call
 * site is one the next call site can forget; this one sits in front of every git command the manager issues,
 * including the ones nobody has written yet.
 */
describe("a run never writes to the checkout the user is standing in", () => {
  const root = "/repo";
  const seen: { args: string[]; cwd: string }[] = [];
  const record = guardRoot(async (args, cwd) => {
    seen.push({ args, cwd });
    return { code: 0, stdout: "", stderr: "" };
  }, root);

  it("refuses every verb that would change the branch, the history or the files", async () => {
    for (const verb of FORBIDDEN_AT_ROOT) {
      await expect(record([verb, "whatever"], root), `git ${verb} was allowed at the root`)
        .rejects.toThrow(/refusing to run/);
    }
  });

  it("names the directory and says whose decision merging is", async () => {
    await expect(record(["merge", "hc/job/base"], root)).rejects.toThrow(/\/repo/);
    await expect(record(["merge", "hc/job/base"], root)).rejects.toThrow(/the user's decision/);
  });

  /** Leading flags come before the verb: `git -c user.email=x commit` is still a commit. */
  it("finds the verb past any leading options", async () => {
    await expect(record(["-c", "user.email=t@t", "commit", "-m", "x"], root)).rejects.toThrow(/refusing/);
  });

  /**
   * The same verbs are ordinary work one directory over. Everything a session does happens in its own
   * worktree, and a guard that stopped that would stop the pipeline.
   */
  it("allows all of them in a session worktree", async () => {
    for (const verb of FORBIDDEN_AT_ROOT) {
      await expect(record([verb, "x"], "/repo/.horsecode/worktrees/job/base")).resolves.toMatchObject({ code: 0 });
    }
  });

  /** Creating a session needs these AT the root, so refusing them would refuse the whole feature. */
  it("leaves repository bookkeeping alone", async () => {
    for (const args of [["worktree", "add", "x"], ["branch", "-D", "hc/old"], ["fetch", "origin"],
      ["status", "--porcelain"], ["rev-parse", "HEAD"], ["for-each-ref"], ["worktree", "prune"]]) {
      await expect(record(args, root)).resolves.toMatchObject({ code: 0 });
    }
  });
});

/**
 * The one commit this pipeline may make in the project checkout, and the proof it is the only one.
 *
 * `git worktree add` has to branch from a commit, and a directory that was never a repository has none —
 * so opening a session there means creating one. There is no branch to disturb and no work to overwrite at
 * that moment, which is exactly what makes it different from delivery.
 */
describe("bootstrapping a directory that is not a repository yet", () => {
  it("creates the repo and its first commit, and merges nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-fresh-"));
    try {
      const seen: string[][] = [];
      const runGit = async (args: string[], cwd: string): ReturnType<typeof defaultGitRunner> => {
        seen.push(args);
        return defaultGitRunner(args, cwd);
      };
      const mgr = new WorktreeManager({ repoRoot: dir, runGit });
      const session = await mgr.openSession("main", "a job");
      expect(session.baseBranch).toMatch(/^hc\//);

      const commits = seen.filter((a) => a.includes("commit"));
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain("--allow-empty");
      expect(seen.some((a) => a[0] === "merge")).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  /** Once there IS history, even that one exemption is off: a second run must not commit at the root. */
  it("makes no commit at all in a repository that already has one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-existing-"));
    try {
      const git = (...args: string[]): void => {
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
      };
      git("init", "-b", "main");
      await writeFile(join(dir, "README.md"), "start\n", "utf8");
      git("add", "-A");
      git("commit", "-m", "initial");

      const seen: string[][] = [];
      const runGit = async (args: string[], cwd: string): ReturnType<typeof defaultGitRunner> => {
        seen.push(args);
        return defaultGitRunner(args, cwd);
      };
      await new WorktreeManager({ repoRoot: dir, runGit }).openSession("main", "a job");
      expect(seen.filter((a) => a.includes("commit"))).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
