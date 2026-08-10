import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitTool, gitWriteTool, refuse, refuseWrite } from "../../src/tools/git.js";
import { readOnlyRegistry } from "../../src/engine/reviewer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const ctx = (cwd: string): Parameters<typeof gitWriteTool.run>[1] =>
  ({ cwd, signal: new AbortController().signal }) as never;

/**
 * The role the user talks to can record work, and only that role.
 *
 * Reported live: `/graph trace` wrote 231 files into the project checkout, the user asked the coach to commit
 * and push them, and the coach answered that it had a read-only git tool and no shell — then printed the
 * three commands for the user to type. Producing work in a place nobody can commit from is not a safety
 * property, it is an unfinished job.
 */
describe("recording work in git", () => {
  it("commits what it was asked to, and the commit is real", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-gw-"));
    try {
      const g = (...a: string[]): string =>
        execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      g("init", "-q");
      g("config", "user.email", "t@example.com");
      g("config", "user.name", "T");
      g("commit", "-q", "--allow-empty", "-m", "one");
      await writeFile(join(dir, "note.md"), "hello\n", "utf8");

      expect((await gitWriteTool.run({ args: ["add", "note.md"] }, ctx(dir))).isError).toBe(false);
      expect((await gitWriteTool.run({ args: ["commit", "-m", "docs: add note"] }, ctx(dir))).isError).toBe(false);
      expect(g("log", "-1", "--pretty=%s").trim()).toBe("docs: add note");
      expect(g("status", "--porcelain").trim()).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Everything else is recoverable; a force push is not, so it is refused rather than asked about. */
  it("refuses to rewrite what is already published", () => {
    for (const flag of ["--force", "-f", "--force-with-lease", "--delete", "--mirror"]) {
      expect(refuseWrite(["push", "origin", "main", flag]), flag).toMatch(/rewrites or removes history/);
    }
    expect(refuseWrite(["push"])).toBeUndefined();
    expect(refuseWrite(["push", "-u", "origin", "HEAD"])).toBeUndefined();
  });

  it("records work and nothing else — it is not a second shell", () => {
    for (const sub of ["reset", "checkout", "clean", "rebase", "stash", "worktree", "config"]) {
      expect(refuseWrite([sub]), sub).toMatch(/is not available here/);
    }
    // …and the arguments that would aim git elsewhere are refused here too.
    expect(refuseWrite(["commit", "--git-dir", "/elsewhere/.git"])).toMatch(/not allowed/);
    expect(refuseWrite(["commit", "-c", "core.pager=sh"])).toMatch(/not allowed/);
  });

  /** It asks. The read tool is `safe` so orientation stays free; this one goes through the permission engine. */
  it("costs a permission prompt, keyed per subcommand", () => {
    expect(gitWriteTool.permissionLevel).toBe("exec");
    expect(gitTool.permissionLevel).toBe("safe");
    // Keyed on the subcommand, so "always allow" for `git commit` does not silently grant `git push`.
    expect(gitWriteTool.describe?.({ args: ["commit", "-m", "x"] }).allowKey).toBe("git commit");
    expect(gitWriteTool.describe?.({ args: ["push"] }).allowKey).toBe("git push");
  });
});

/**
 * A reviewer that could commit would be judging work it had just recorded.
 *
 * Neither the reviewer nor the tester was ever asked to record anything, and the read-only toolset is what
 * makes their verdict worth having — so the write tool is opt-in, and only the coach opts in.
 */
describe("who is allowed to record work", () => {
  const deps = { skillRegistry: new SkillRegistry() } as unknown as TaskCycleDeps;
  const names = (r: ReturnType<typeof readOnlyRegistry>): string[] => r.list().map((t) => t.name);

  it("is nobody by default", () => {
    expect(names(readOnlyRegistry(deps))).not.toContain("git_write");
    expect(names(readOnlyRegistry(deps, { propose: true }))).not.toContain("git_write");
  });

  it("is the coach, which asks for it", () => {
    expect(names(readOnlyRegistry(deps, { gitWrite: true }))).toContain("git_write");
  });

  it("is what the coach asks for", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/coach.ts", "utf8");
    expect(src).toContain("gitWrite: true");
  });

  /** Reading git stays free for everyone: orientation that cannot change a byte must not cost a prompt. */
  it("never takes the reading tool away", () => {
    for (const opts of [{}, { propose: true }, { gitWrite: true }]) {
      expect(names(readOnlyRegistry(deps, opts))).toContain("git");
    }
  });
});

/**
 * Seeing whether the remote has moved, and bringing the refs up to date.
 *
 * Reported live: a coach asked to "sync the origin development branch and continue" answered "git fetch is
 * not supported by this read-only tool, so I cannot see the real synchronisation state", then reasoned from
 * the last known local state instead. Two different answers were missing — one that reads the remote without
 * touching anything, and one that updates the remote-tracking refs.
 */
describe("asking the remote where it is", () => {
  it("reads it without writing anything", () => {
    // ls-remote reaches the network and writes nothing at all: not the tree, not a ref, not the object store.
    expect(refuse(["ls-remote", "--heads", "origin"])).toBeUndefined();
    expect(gitTool.permissionLevel).toBe("safe");
  });

  it("fetches through the tool that asks permission", () => {
    expect(refuse(["fetch"])).toMatch(/not available here/);   // …never from the read-only side
    expect(refuseWrite(["fetch"])).toBeUndefined();
    expect(refuseWrite(["fetch", "origin"])).toBeUndefined();
    expect(gitWriteTool.describe?.({ args: ["fetch"] }).allowKey).toBe("git fetch");
  });

  /**
   * A refspec can move LOCAL branches — including the one the session is standing on — without touching a
   * single file. That is the one form of fetch that must not be reachable from here.
   */
  it("refuses the form that could move a local branch", () => {
    expect(refuseWrite(["fetch", "origin", "+refs/heads/*:refs/heads/*"])).toMatch(/refspec/i);
    expect(refuseWrite(["fetch", "origin", "main:main"])).toMatch(/refspec/i);
  });

  it("refuses to delete remote-tracking refs", () => {
    for (const flag of ["--prune", "-p"]) expect(refuseWrite(["fetch", "origin", flag]), flag).toMatch(/deletes/);
  });

  /** Merging what was fetched is a different decision, with its own conflict machinery. It stays out. */
  it("does not merge what it fetched", () => {
    for (const sub of ["pull", "merge", "rebase", "reset"]) {
      expect(refuseWrite([sub]), sub).toMatch(/is not available here/);
    }
  });
});
