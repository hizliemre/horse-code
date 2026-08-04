import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inLinkedWorktree } from "../../src/engine/session-scope.js";

let dir: string;
let repo: string;
const git = (cwd: string) => (args: string[]): string | undefined => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return undefined; }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-wt-"));
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  const g = git(repo);
  g(["init", "-q"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "T"]);
  g(["commit", "-q", "--allow-empty", "-m", "one"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * A worktree cut from a worktree is a checkout nobody asked for, nested inside one someone did.
 *
 * Measured after a document-producing run in a project checkout: `specs/004-product-upload-testing/` left
 * untracked in the repository root, beside two shared files a start-up pass had modified. The rule is the
 * same as for code — what a run produces belongs on a branch — with one exception that matters: a run that
 * starts inside a worktree stays there.
 */
describe("whether a run is already standing in a worktree", () => {
  it("says no in the repository's own checkout", () => {
    expect(inLinkedWorktree(repo, git(repo))).toBe(false);
  });

  it("says yes in a linked worktree, wherever it lives", () => {
    const wt = join(dir, "elsewhere", "feature-x");
    git(repo)(["worktree", "add", "-q", "-b", "feature-x", wt]);
    expect(inLinkedWorktree(wt, git(wt))).toBe(true);
  });

  it("says yes from a subdirectory of one", async () => {
    const wt = join(dir, "wt");
    git(repo)(["worktree", "add", "-q", "-b", "feature-y", wt]);
    const deep = join(wt, "src", "nested");
    await mkdir(deep, { recursive: true });
    expect(inLinkedWorktree(deep, git(deep))).toBe(true);
  });

  /** horse-code's own session bases count too, whatever git says about them. */
  it("says yes inside a session base", async () => {
    const base = join(dir, "proj", ".horsecode", "worktrees", "job", "base");
    await mkdir(base, { recursive: true });
    expect(inLinkedWorktree(base, () => undefined)).toBe(true);
  });

  it("says no when git cannot answer at all", () => {
    expect(inLinkedWorktree(join(dir, "not-a-repo"), () => undefined)).toBe(false);
  });
});

/**
 * The exception has an exception: asking for one branches anyway.
 *
 * The phrase is the only thing that can distinguish "I am working in this worktree" from "give this its own".
 */
describe("asking for a worktree explicitly", () => {
  it("is what the document lanes look for", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/upstream.ts", "utf8");
    const fn = src.slice(src.indexOf("async function documentWorkdir"), src.indexOf("async function documentWorkdir") + 400);
    expect(fn).toContain("inLinkedWorktree");
    expect(fn).toContain("WANTS_WORKTREE.test(prompt)");
    // …and both document lanes go through it rather than reaching for process.cwd() themselves.
    for (const lane of ['routeIntent(r.intent) === "verify"', 'routeIntent(r.intent) === "govern"']) {
      const at = src.indexOf(lane);
      expect(src.slice(at, at + 400), lane).toContain("documentWorkdir(process.cwd()");
    }
  });
});
