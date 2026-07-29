import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasWorkAgainst, worktreeState } from "../../src/engine/worktree-state.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo: string | undefined;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = undefined; });

/**
 * The question before a review is not "did this attempt add something" but "is there anything to judge".
 *
 * A retried task carries its earlier work in its worktree, so an implementer that looks, sees the job already
 * done and writes nothing is making a correct observation — not failing. Treating those as failures did real
 * damage: it recorded strikes against `cc/claude-opus-4-8` and benched it from `senior-coder` on 2 of 2, for
 * declining to rewrite code that was already there.
 */
describe("hasWorkAgainst", () => {
  it("is false on a worktree that matches its base", async () => {
    repo = await initTmpRepo();
    expect(await hasWorkAgainst(defaultGitRunner, repo, "HEAD")).toBe(false);
  });

  it("is true for work that is only committed", async () => {
    repo = await initTmpRepo();
    const base = (await defaultGitRunner(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
    await defaultGitRunner(["add", "-A"], repo);
    await defaultGitRunner(["commit", "-m", "work"], repo);
    expect(await hasWorkAgainst(defaultGitRunner, repo, base)).toBe(true);
  });

  it("is true for work that is only uncommitted", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "b.ts"), "export const b = 2;\n");
    expect(await hasWorkAgainst(defaultGitRunner, repo, "HEAD")).toBe(true);
  });

  /** Cannot tell → false, so the caller falls back to its own before/after check rather than guessing. */
  it("is false when git cannot answer", async () => {
    expect(await hasWorkAgainst(defaultGitRunner, "/nowhere-at-all", "HEAD")).toBe(false);
  });
});

describe("worktreeState", () => {
  it("changes when a file is written, and not otherwise", async () => {
    repo = await initTmpRepo();
    const a = await worktreeState(defaultGitRunner, repo);
    expect(await worktreeState(defaultGitRunner, repo)).toBe(a); // stable
    await writeFile(join(repo, "c.ts"), "export const c = 3;\n");
    expect(await worktreeState(defaultGitRunner, repo)).not.toBe(a);
  });

  it("is undefined where git cannot answer, which disables the guard", async () => {
    expect(await worktreeState(defaultGitRunner, "/nowhere-at-all")).toBeUndefined();
  });
});
