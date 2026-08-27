import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";

let repo: string;
const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo }).toString();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "hc-deliver-"));
  git("init", "-b", "main");
  /**
   * The identity goes into the REPOSITORY, not just onto this file's own git calls.
   *
   * `git(...)` above passes `-c user.email=…`, which covers what the test runs and nothing else. The code
   * under test makes its own git calls, and `git merge --no-ff -m …` has to write a commit — so on a machine
   * with no global identity it fails with "Please tell me who you are". A developer laptop has one; a fresh
   * CI runner does not, which is why four of these passed everywhere except where it mattered.
   */
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await writeFile(join(repo, "README.md"), "start\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "initial");
  // The job's branch, with work on it — what a finished run leaves behind.
  git("branch", "hc/job/base");
  git("checkout", "hc/job/base");
  await writeFile(join(repo, "app.ts"), "export const x = 1;\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "hc: build the app");
  git("checkout", "main");
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

const session = (): WorktreeSession =>
  ({ jobSlug: "job", baseBranch: "hc/job/base", baseWorktree: repo }) as WorktreeSession;

const manager = (): WorktreeManager => new WorktreeManager({ repoRoot: repo });

/**
 * A pull request is delivery when there is a remote to open it against. Without one, `push` is a no-op and a
 * PR has nowhere to go — so a finished project stays on `hc/<job>/base`, invisible from the repository root.
 */
describe("deliverLocally", () => {
  it("merges the work into the branch the job started from", async () => {
    const r = await manager().deliverLocally(session(), "main");
    expect(r).toEqual({ ok: true, commits: 1 });
    expect(git("ls-tree", "-r", "--name-only", "main")).toContain("app.ts");
  });

  /** One merge commit keeps the job legible; a fast-forward would scatter its commits with no record. */
  it("records the job as a single merge", async () => {
    await manager().deliverLocally(session(), "main");
    expect(git("log", "-1", "--format=%s", "main").trim()).toBe("hc: job");
    expect(git("log", "-1", "--format=%p", "main").trim().split(" ")).toHaveLength(2);
  });

  it("is a no-op when the branch is already contained", async () => {
    await manager().deliverLocally(session(), "main");
    expect(await manager().deliverLocally(session(), "main")).toEqual({ ok: true, commits: 0 });
  });

  /**
   * Refuses rather than forces. A dirty working copy means the user has something in progress, and
   * overwriting it to deliver would be a worse failure than not delivering — the branch still exists.
   */
  it("refuses when the working copy has uncommitted changes", async () => {
    await writeFile(join(repo, "README.md"), "edited by the user\n", "utf8");
    const r = await manager().deliverLocally(session(), "main");
    expect(r).toEqual({ ok: false, why: "the working copy has uncommitted changes" });
  });

  // Untracked files are not work in progress on a tracked file; they do not block a merge.
  it("is not blocked by untracked files", async () => {
    await writeFile(join(repo, "scratch.txt"), "notes\n", "utf8");
    expect((await manager().deliverLocally(session(), "main")).ok).toBe(true);
  });

  it("refuses when the repository is on another branch, and says which", async () => {
    git("checkout", "-b", "my-own-work");
    const r = await manager().deliverLocally(session(), "main");
    expect(r).toEqual({ ok: false, why: "the repository is on `my-own-work`, not `main`" });
  });

  it("reports a conflicting merge rather than leaving the repo half-merged", async () => {
    await writeFile(join(repo, "app.ts"), "export const x = 2;\n", "utf8");
    git("add", "-A");
    git("commit", "-m", "conflicting change on main");
    const r = await manager().deliverLocally(session(), "main");
    expect(r).toEqual({ ok: false, why: "the merge did not apply cleanly" });
  });
});
