import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTool, refuse, howToNarrow, answeredWithOne, answerOfOne } from "../../src/tools/git.js";
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
      /**
       * Refused AND told which word did it — the property that matters, rather than one fixed phrase.
       *
       * This used to match `/not available here|not allowed/`. Per-subcommand rules say it differently
       * ("`git branch -D` changes a branch. Only listing is allowed."), and rewording a refusal must not
       * fail a test about refusing. What must stay true is that the message names the thing refused.
       */
      expect(res.content, args.join(" ")).toContain(args[0] as string);
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

/**
 * A remedy the model cannot use is worse than silence — it will spend a turn discovering that.
 *
 * `--stat` belongs to `git diff` and was appended to every truncated result. Measured live: a lens ran
 * `git ls-files -- *.slnx src toucan docs`, got 60,124 characters back, and was told to try a flag
 * `ls-files` does not have.
 */
describe("what to do about output too big to return", () => {
  it("keeps the --stat advice where it is true, including where the flag must go", () => {
    const text = howToNarrow(["diff", "development...HEAD"]);
    expect(text).toContain("--stat");
    expect(text).toContain("directly after the subcommand");
  });

  it("does not offer --stat to a subcommand that has no such flag", () => {
    for (const verb of ["ls-files", "log", "blame", "status"]) {
      expect(howToNarrow([verb]), verb).not.toContain("--stat");
    }
  });

  it("names the narrowing that actually fits each subcommand", () => {
    expect(howToNarrow(["ls-files", "--", "src"])).toContain("pathspec");
    expect(howToNarrow(["log"])).toContain("--oneline");
    expect(howToNarrow(["blame", "a.ts"])).toContain("-L");
  });

  /** Leading flags come before the verb — the same misreading that let `git -c x commit` past a guard. */
  it("finds the subcommand past leading options", () => {
    expect(howToNarrow(["-c", "core.pager=cat", "diff"])).toContain("--stat");
  });

  it("still says something useful for a subcommand nobody anticipated", () => {
    expect(howToNarrow(["cat-file", "-p", "HEAD"])).toContain("narrower");
  });
});

/**
 * A short flag admitted and its long twin refused is not a boundary, it is a typo in one.
 *
 * Measured in one run: an agent asked for `git branch --all` and then `git branch --show-current`, and paid
 * a refused turn for each — while `branch -a`, the same command spelled the other way, sat in the allowlist.
 */
describe("the read-only forms of a subcommand that also writes", () => {
  it("admits the long spelling of what the short one already allowed", () => {
    for (const args of [["branch", "--all"], ["branch", "--verbose"], ["branch", "--remotes"]]) {
      expect(refuse(args), args.join(" ")).toBeUndefined();
    }
  });

  it("admits the queries that only ask", () => {
    for (const args of [["branch", "--show-current"], ["branch", "--merged"], ["branch", "--points-at", "HEAD"],
      ["tag", "--contains", "HEAD"], ["remote", "get-url", "origin"], ["stash", "show"]]) {
      expect(refuse(args), args.join(" ")).toBeUndefined();
    }
  });

  /** The point of the list is what it still keeps out, and that must not have moved. */
  it("still refuses every form that changes a ref", () => {
    for (const args of [["branch", "-d", "x"], ["branch", "-D", "x"], ["branch", "--delete", "x"],
      ["branch", "-m", "a", "b"], ["branch", "--move", "a", "b"], ["branch", "--set-upstream-to=o/x"],
      ["tag", "-d", "v1"], ["stash", "pop"], ["stash", "drop"], ["worktree", "add", "p"],
      ["remote", "add", "o", "u"], ["config", "--global", "user.name", "x"]]) {
      expect(refuse(args), args.join(" ")).toBeDefined();
    }
  });

  /** A bare `git branch <name>` creates one, and no flag list can catch that — the first word must be a flag. */
  it("still refuses a branch name given as a positional argument", () => {
    expect(refuse(["branch", "new-feature"])).toBeDefined();
  });
});

/**
 * A whole pathspec section packed into one argument, which git reads as one nonsensical revision.
 *
 * Measured live: `["log","-8","--oneline","--all","-- src/domain/Definitions/ChannelType.cs src/infra…"]`.
 * git answers `fatal: unrecognized argument: -- src/... src/...` — true, and silent about the shape that
 * was wrong. The model sent the same shape four more times, across two agents.
 */
describe("arguments packed into one string", () => {
  /**
   * Leads with the rule about `--`, because the first wording sent the model the wrong way.
   *
   * It said "each argument must be its own element — this one holds several". Measured live, one turn
   * later: the agent resent `["-- src/a.cs"]`, having dropped the second path and kept the packing. It
   * fixed the count, which is the symptom. A remedy the model misreads costs the same turn as none.
   */
  it("names the separator first, then shows the exact correction", () => {
    const why = refuse(["log", "--oneline", "-- src/a.cs src/b.cs"]);
    expect(why).toMatch(/^`--` is the separator/);
    expect(why).toContain('["--","src/a.cs","src/b.cs"]');
    expect(why).toContain("however many paths follow");
  });

  /** One path packed is the same fault as two, and must not read as a complaint about the count. */
  it("says the same thing when only one path was packed", () => {
    const why = refuse(["log", "-- src/a.cs"]);
    expect(why).toMatch(/^`--` is the separator/);
    expect(why).toContain('["--","src/a.cs"]');
  });

  it("catches it before the subcommand check, so the advice is about the real problem", () => {
    expect(refuse(["log", "-- a b"])).toContain("its own element");
    expect(refuse(["cherry-pick", "-- a b"])).toContain("its own element");
  });

  /** Flags whose VALUE contains a space are legitimate and must not be caught. */
  it("leaves a flag value that contains spaces alone", () => {
    for (const a of ["--grep=two words", "--author=A B", "--pretty=format:%h %s", "--date=format:%Y %m"]) {
      expect(refuse(["log", a]), a).toBeUndefined();
    }
  });

  /** A correctly split pathspec is the normal case and must stay silent. */
  it("leaves a properly split pathspec alone", () => {
    expect(refuse(["log", "--oneline", "--", "src/a.cs", "src/b.cs"])).toBeUndefined();
  });
});

/**
 * Four more read-only calls that were refused in one 36-minute run.
 *
 * `git grep` twice — while agents fell back to `find | xargs grep` through the shell, which is slower on a
 * repository this size and searches build output and node_modules unless every caller remembers to prune
 * them. `reflog -5`, `branch -vv`, and `config core.ignorecase` each once. None of them writes anything.
 */
describe("read-only calls that were being refused", () => {
  it("allows git grep, which has no writing form at all", () => {
    expect(refuse(["grep", "-n", "SupplierRelation"])).toBeUndefined();
    expect(refuse(["grep", "-l", "--", "src"])).toBeUndefined();
  });

  it("allows reading the reflog, and refuses the two forms that rewrite it", () => {
    expect(refuse(["reflog"])).toBeUndefined();
    expect(refuse(["reflog", "-5"])).toBeUndefined();
    expect(refuse(["reflog", "show", "HEAD"])).toBeUndefined();
    expect(refuse(["reflog", "expire", "--all"])).toContain("rewrites the reflog");
    expect(refuse(["reflog", "delete", "HEAD@{0}"])).toContain("rewrites the reflog");
  });

  it("allows a bare config key, and refuses setting one", () => {
    expect(refuse(["config", "core.ignorecase"])).toBeUndefined();
    expect(refuse(["config", "--get", "core.ignorecase"])).toBeUndefined();
    expect(refuse(["config", "user.name", "someone"])).toContain("writes configuration");
    expect(refuse(["config", "--global", "user.name", "someone"])).toBeDefined();
  });

  it("allows branch -vv, which is branch -v twice over", () => {
    expect(refuse(["branch", "-vv"])).toBeUndefined();
  });
});

/**
 * `branch` is enumerated by what WRITES, because what reads is combinatorial.
 *
 * The pair list grew twice in one evening — `--all`, `--show-current`, `--contains`, `-vv` — and then
 * `-avv` arrived, which is `-a` and `-vv` in one token. There is no end to that: `-av`, `-rv`, `-vvr`,
 * every ordering. The readers are open-ended; the writers are five verbs git has not added to in years.
 */
describe("git branch, judged by what it would change", () => {
  it("allows the combinations that defeated the old list", () => {
    for (const a of [["branch"], ["branch", "-a"], ["branch", "-v"], ["branch", "-vv"], ["branch", "-avv"],
      ["branch", "-av"], ["branch", "-rv"], ["branch", "--all"], ["branch", "--show-current"],
      ["branch", "--list"], ["branch", "--merged"], ["branch", "--contains", "HEAD"],
      ["branch", "--format=%(refname)"], ["branch", "--sort", "-committerdate"]]) {
      expect(refuse(a), a.join(" ")).toBeUndefined();
    }
  });

  it("refuses every form that deletes, renames, copies or re-points", () => {
    for (const a of [["branch", "-d", "x"], ["branch", "-D", "x"], ["branch", "--delete", "x"],
      ["branch", "-m", "a", "b"], ["branch", "-M", "a", "b"], ["branch", "--move", "a"],
      ["branch", "-c", "a"], ["branch", "--copy", "a"], ["branch", "--set-upstream-to=origin/x"],
      ["branch", "--unset-upstream"], ["branch", "-f", "x", "HEAD"], ["branch", "--edit-description"]]) {
      expect(refuse(a), a.join(" ")).toBeDefined();
    }
  });

  /** Short flags combine, so each letter is judged on its own — that is what `-avv` taught. */
  it("finds a writing letter inside a combined short flag", () => {
    expect(refuse(["branch", "-avd", "x"])).toContain("changes a branch");
    expect(refuse(["branch", "-Dv"])).toContain("changes a branch");
  });

  /** Creating has no flag: the bare name IS the command. */
  it("refuses a bare branch name, and does not mistake a query's value for one", () => {
    expect(refuse(["branch", "new-feature"])).toContain("creates a branch");
    expect(refuse(["branch", "--contains", "some-ref"])).toBeUndefined();
    expect(refuse(["branch", "--points-at", "HEAD"])).toBeUndefined();
  });
});

/** The same mis-split with the space left out — `--toucan/libs/beempa` instead of `--`, `toucan/…`. */
describe("a separator glued to its path", () => {
  it("is named, with the list it should have been", () => {
    const why = refuse(["diff", "--toucan/libs/beempa/suppliers/models"]);
    expect(why).toContain("its own element");
    expect(why).toContain('["--","toucan/libs/beempa/suppliers/models"]');
  });

  /** A long flag carrying a path always spells it with `=`, which is what keeps this tight. */
  it("leaves real long options alone", () => {
    for (const a of ["--src-prefix=a/", "--pretty=format:%h", "--stat", "--name-only", "--no-color"]) {
      expect(refuse(["diff", a]), a).toBeUndefined();
    }
  });

  /**
   * `--git-dir=` and `--work-tree=` hold slashes and ARE refused — but for pointing git at another
   * repository, which is a security boundary. Reporting them as a mis-split would send the model to fix
   * its punctuation when the answer is that it may not do this at all.
   */
  it("does not relabel a security refusal as a formatting mistake", () => {
    for (const a of ["--git-dir=/x/.git", "--work-tree=/x", "--output=/tmp/f"]) {
      const why = refuse(["diff", a]);
      expect(why, a).toBeDefined();
      expect(why, a).not.toContain("its own element");
    }
  });

  it("leaves a properly separated pathspec alone", () => {
    expect(refuse(["diff", "--", "toucan/libs"])).toBeUndefined();
  });
});

/**
 * `git grep` says "no match" with exit 1 — an answer, not a fault.
 *
 * It was admitted to the read-only set earlier tonight and left out of ANSWERS_WITH_ONE, so a search that
 * found nothing came back as `git failed with no output.` Measured live within minutes of the first fix:
 * two `git grep` calls for a file that is not in the repository, both reported as failures.
 */
describe("a search that found nothing", () => {
  it("is an answer, not a failure", () => {
    expect(answeredWithOne(["grep", "-n", "nothing-here"], 1)).toBe(true);
    expect(answerOfOne(["grep", "-n", "nothing-here"])).toContain("No match");
  });

  /** git's real faults keep their meaning: 128 and above are never answers. */
  it("still treats a genuine git fault as one", () => {
    expect(answeredWithOne(["grep", "-n", "x"], 128)).toBe(false);
  });

  it("leaves the other answer-with-one verbs saying their own thing", () => {
    expect(answerOfOne(["check-ignore", "x"])).toContain("not ignored");
    expect(answerOfOne(["merge-base", "--is-ancestor", "a", "b"])).toContain("not an ancestor");
  });
});
