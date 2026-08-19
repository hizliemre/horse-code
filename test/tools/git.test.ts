import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
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

/**
 * Git uses exit code 1 as an ANSWER for some queries, and reporting it as a failure hands an agent the
 * answer while telling it the question could not be answered.
 *
 * Measured live: a project-manager asked twice in ten seconds; both replies were marked errors, each
 * carrying the diff it had asked for. The same shape as prettier's exit 1 — a working tool saying "yes".
 */
describe("an exit code that is an answer", () => {
  it("knows which queries answer with 1", async () => {
    const { answeredWithOne } = await import("../../src/tools/git.js");
    expect(answeredWithOne(["diff", "--exit-code"], 1)).toBe(true);
    expect(answeredWithOne(["merge-base", "--is-ancestor", "a", "b"], 1)).toBe(true);
    // …and which do not.
    expect(answeredWithOne(["status"], 1)).toBe(false);
    expect(answeredWithOne(["log"], 1)).toBe(false);
  });

  /** 128 and up are git's own faults — a bad object, not a repository — and never an answer. */
  it("never reads a fault as an answer", async () => {
    const { answeredWithOne } = await import("../../src/tools/git.js");
    expect(answeredWithOne(["diff", "--exit-code"], 128)).toBe(false);
    expect(answeredWithOne(["merge-base", "a", "b"], 129)).toBe(false);
  });

  /** With `--quiet` git prints nothing at all, so the answer has to be said in words. */
  it("says what 1 meant when git printed nothing", async () => {
    const { answerOfOne } = await import("../../src/tools/git.js");
    expect(answerOfOne(["diff", "--quiet"])).toMatch(/ARE differences/);
    expect(answerOfOne(["merge-base", "--is-ancestor", "a", "b"])).toMatch(/not an ancestor/);
    expect(answerOfOne(["merge-base", "a", "b"])).toMatch(/no common ancestor/i);
  });

  it("reports a real diff as a result, not as a failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-git-exit-"));
    try {
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      run("git init -q");
      run("git config user.email t@t.t"); run("git config user.name T");
      await writeFile(join(dir, "a.txt"), "one\n");
      run("git add a.txt"); run("git commit -qm first");
      await writeFile(join(dir, "a.txt"), "two\n");
      const r = await gitTool.run({ args: ["diff", "--exit-code"] },
        { cwd: dir, signal: new AbortController().signal } as never);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("-one");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/**
 * Advice that produces a failure is worse than no advice.
 *
 * The truncation notice said "narrow the range or add --stat". Measured live: a lens appended the flag after
 * the paths, and git answered `fatal: option '--stat' must come before non-option arguments`. Git requires
 * options before non-option arguments, so the notice has to say where the flag goes.
 */
describe("what a truncated result suggests", () => {
  it("names where the flag belongs, not just which flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-git-trunc-"));
    try {
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      run("git init -q");
      run("git config user.email t@t.t"); run("git config user.name T");
      await writeFile(join(dir, "a.txt"), "x\n");
      run("git add a.txt"); run("git commit -qm first");
      // A diff far larger than the output ceiling, so the notice is appended.
      await writeFile(join(dir, "a.txt"), `${"line of text\n".repeat(8_000)}`);
      const r = await gitTool.run({ args: ["diff"] },
        { cwd: dir, signal: new AbortController().signal } as never);
      expect(r.content).toContain("truncated");
      expect(r.content).toContain("directly after the subcommand");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/**
 * `check-ignore` was the one read-only verb agents had to reach for `shell` to run — four calls in one run,
 * each landing outside the tool that knows this repository's rules, and each with a raw exit code: "no, that
 * path is not ignored", which git says with 1, came back as a failed command.
 */
describe("asking whether a path is ignored", () => {
  it("is allowed — it reads the rules and changes nothing", async () => {
    const { refuse } = await import("../../src/tools/git.js");
    expect(refuse(["check-ignore", "-v", "src/a.cs"])).toBeUndefined();
  });

  it("reads exit 1 as the answer it is", async () => {
    const { answeredWithOne, answerOfOne } = await import("../../src/tools/git.js");
    expect(answeredWithOne(["check-ignore", "src/a.cs"], 1)).toBe(true);
    expect(answerOfOne(["check-ignore", "src/a.cs"])).toMatch(/not ignored/);
  });

  it("answers a real repository without calling it a failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-git-ci-"));
    try {
      execSync("git init -q", { cwd: dir, stdio: "pipe" });
      await writeFile(join(dir, ".gitignore"), "build/\n");
      const r = await gitTool.run({ args: ["check-ignore", "src/a.cs"] },
        { cwd: dir, signal: new AbortController().signal } as never);
      expect(r.isError).toBe(false);
      expect(r.content).toMatch(/not ignored/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
