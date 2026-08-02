import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTool, refuse } from "../../src/tools/git.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo: string;
beforeEach(async () => { repo = await initTmpRepo(); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });
const ctx = (): { cwd: string; signal: AbortSignal } => ({ cwd: repo, signal: new AbortController().signal });

/**
 * A coach asked to review a branch had no way to run `git status` — "there is no shell tool in this
 * environment" — and spent its whole turn budget reconstructing from file reads what one command answers
 * exactly. Read-only was the right shape for the role; unable to ASK git anything was an accident of it.
 */
describe("git: what only git knows", () => {
  it("answers the question the coach could not ask", async () => {
    await writeFile(join(repo, "new.ts"), "x", "utf8");
    const res = await gitTool.run({ args: ["status", "--porcelain"] }, ctx() as never);
    expect(res.isError).toBe(false);
    expect(res.content).toContain("new.ts");
  });

  it("reads history", async () => {
    const res = await gitTool.run({ args: ["log", "-1", "--oneline"] }, ctx() as never);
    expect(res.isError).toBe(false);
    expect(res.content.trim()).not.toBe("");
  });
});

describe("git: what it refuses, and why", () => {
  /** The whole point: a role with this tool must not be able to change the user's repository. */
  it("refuses the commands that change things", async () => {
    for (const args of [["checkout", "main"], ["commit", "-m", "x"], ["reset", "--hard"], ["clean", "-fd"],
      ["branch", "-D", "main"], ["stash"], ["worktree", "add", "/tmp/x"], ["push"], ["rebase", "main"]]) {
      const res = await gitTool.run({ args }, ctx() as never);
      expect(res.isError, args.join(" ")).toBe(true);
      expect(res.content, args.join(" ")).toMatch(/not available here|not allowed/);
    }
  });

  it("allows the reading FORM of a subcommand that also writes", () => {
    expect(refuse(["worktree", "list"])).toBeUndefined();
    expect(refuse(["branch", "--list"])).toBeUndefined();
    expect(refuse(["stash", "list"])).toBeUndefined();
    // …and never the writing form of the same one.
    expect(refuse(["worktree", "add"])).toBeTruthy();
    expect(refuse(["stash", "push"])).toBeTruthy();
  });

  /**
   * `--output` turns a diff into a file write; `-c` injects configuration, and `core.pager`, `alias.*` and
   * hooks all run programs; `-C`/`--git-dir` point git at another repository, which would make the cwd this
   * tool is scoped to a suggestion rather than a boundary.
   */
  it("refuses arguments that write, run a program, or leave the working directory", async () => {
    const before = (await readdir(repo)).length;
    for (const args of [["diff", "--output=/tmp/leak.txt"], ["-c", "core.pager=sh -c 'id'", "log"],
      ["-C", "/etc", "status"], ["--git-dir=/tmp/other/.git", "log"], ["log", "--exec-path=/tmp"]]) {
      const res = await gitTool.run({ args }, ctx() as never);
      expect(res.isError, args.join(" ")).toBe(true);
    }
    expect(existsSync("/tmp/leak.txt")).toBe(false);
    expect((await readdir(repo)).length).toBe(before);
  });

  it("will not take a bare flag as a subcommand", () => {
    expect(refuse(["--version"])).toMatch(/must be a git subcommand/);
    expect(refuse([])).toMatch(/must be a git subcommand/);
  });

  /** There is no shell: the binary is `git` and the arguments are a list, so `;` and `$(…)` are just text. */
  it("passes a shell metacharacter through as an argument, not as a command", async () => {
    const res = await gitTool.run({ args: ["log", "--grep=; touch /tmp/pwned"] }, ctx() as never);
    expect(existsSync("/tmp/pwned")).toBe(false);
    expect(res.content).toBeDefined();
  });
});
