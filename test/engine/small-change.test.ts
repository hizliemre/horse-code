import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { dirtyPaths, commitOnly } from "../../src/engine/fix.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo: string;
const g = (args: string[]) => defaultGitRunner(args, repo);
beforeEach(async () => { repo = await initTmpRepo(); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/**
 * Committing on someone's branch means committing exactly what was done and nothing else.
 *
 * `git add -A` sweeps the whole working tree, and a working tree is never only the change: a session leaves
 * `.horsecode/memory.jsonl` modified, a verification leaves a half-written report, and a developer has their
 * own edits in progress. Folding those into a commit titled after a one-line fix is how work disappears into
 * a message that does not mention it.
 */
describe("what an automatic commit is allowed to take", () => {
  it("takes only what changed while the work was being done", async () => {
    await writeFile(join(repo, "mine.ts"), "my own edit\n", "utf8");   // the developer's, already there
    const before = await dirtyPaths(defaultGitRunner, repo);

    await writeFile(join(repo, "icon.css"), ".icon { margin: auto }\n", "utf8");  // the change
    expect(await commitOnly(defaultGitRunner, repo, before, "fix: centre the icon")).toBe(true);

    const log = await g(["log", "-1", "--name-only", "--format=%s"]);
    expect(log.stdout).toContain("fix: centre the icon");
    expect(log.stdout).toContain("icon.css");
    expect(log.stdout).not.toContain("mine.ts");   // …and the developer's edit is left alone
    expect((await g(["status", "--porcelain"])).stdout).toContain("mine.ts");
  });

  it("takes a file it modified as well as one it created", async () => {
    await writeFile(join(repo, "a.ts"), "one\n", "utf8");
    await g(["add", "-A"]); await g(["commit", "-m", "seed"]);
    const before = await dirtyPaths(defaultGitRunner, repo);
    await writeFile(join(repo, "a.ts"), "two\n", "utf8");
    await commitOnly(defaultGitRunner, repo, before, "fix: change a");
    expect((await g(["log", "-1", "--name-only", "--format="])).stdout).toContain("a.ts");
  });

  it("commits nothing when the work wrote nothing — an empty commit says something happened", async () => {
    const before = await dirtyPaths(defaultGitRunner, repo);
    expect(await commitOnly(defaultGitRunner, repo, before, "fix: nothing")).toBe(false);
    expect((await g(["log", "--oneline"])).stdout.split("\n").filter(Boolean)).toHaveLength(1); // just the seed
  });

  it("leaves a file that was ALREADY dirty out, even when the work touched it too", async () => {
    await writeFile(join(repo, "shared.ts"), "developer's version\n", "utf8");
    const before = await dirtyPaths(defaultGitRunner, repo);
    await writeFile(join(repo, "shared.ts"), "developer's version + the fix\n", "utf8");
    await writeFile(join(repo, "new.ts"), "the fix\n", "utf8");
    await commitOnly(defaultGitRunner, repo, before, "fix: x");
    const names = (await g(["log", "-1", "--name-only", "--format="])).stdout;
    expect(names).toContain("new.ts");
    // Uncommittable without taking the developer's half of it: left for them to sort out.
    expect(names).not.toContain("shared.ts");
  });
});
