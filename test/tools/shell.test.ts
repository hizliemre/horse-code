import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { shellTool, clampOutput, MAX_SHELL_CHARS } from "../../src/tools/shell.js";

const ctx = (signal?: AbortSignal) => ({
  cwd: tmpdir(),
  signal: signal ?? new AbortController().signal,
});

describe("shell", () => {
  it("returns the output of a successful command (exit 0)", async () => {
    const res = await shellTool.run({ command: "echo hello" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("hello");
  });

  it("returns isError:true for a failing command", async () => {
    const res = await shellTool.run({ command: "exit 3" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("3");
  });

  it("describe produces allowKey + preview", () => {
    const d = shellTool.describe!({ command: "npm test" });
    expect(d.allowKey).toBe("npm test");
    expect(d.preview).toBe("npm test");
  });

  it("returns isError for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await shellTool.run({ command: "echo x" }, ctx(ac.signal));
    expect(res.isError).toBe(true);
  });

  it("returns isError:true without throwing for invalid args (missing command)", async () => {
    const res = await shellTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

// An `ng build` / `npm install` log entered the conversation whole and was then re-sent on every later turn —
// the one large input channel with no bound at all.
describe("clampOutput", () => {
  it("leaves ordinary output untouched", () => {
    expect(clampOutput("small output")).toBe("small output");
  });

  it("keeps the head AND the tail — the failure and the exit summary live at the end", () => {
    const body = `START${"x".repeat(MAX_SHELL_CHARS * 2)}THE-ACTUAL-ERROR`;
    const out = clampOutput(body);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("THE-ACTUAL-ERROR")).toBe(true);
  });

  it("stays within the budget and says what it dropped", () => {
    const out = clampOutput("y".repeat(MAX_SHELL_CHARS * 3));
    expect(out.length).toBeLessThan(MAX_SHELL_CHARS + 200);
    expect(out).toMatch(/trimmed from the middle/);
  });
});

/**
 * With `shell: true` the child is `/bin/sh`, and `child.kill()` reaches the shell and nothing else.
 *
 * A command like `npm start` therefore survived its own timeout as an orphan — still running long after the
 * agent had moved on, and still holding the terminal it shares with the TUI. Killing the whole group is what
 * makes a timeout mean what it says.
 */
describe("a timed-out command takes everything it started with it", () => {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it("kills the grandchild, not just the shell", async () => {
    // Backgrounded, so `sh` does NOT exec into it: a real grandchild, which is the case that used to leak.
    const grandchild = `node -e "setInterval(()=>{},1000)" & echo $!; wait`;
    const r = await shellTool.run(
      { command: grandchild, timeout: 400 },
      { cwd: process.cwd(), signal: new AbortController().signal },
    );
    const pid = Number(/(\d+)/.exec(r.content)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(r.isError).toBe(true);           // it was killed, not finished
    await new Promise((res) => setTimeout(res, 300)); // SIGTERM → SIGKILL grace
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("kills the tree on abort too", async () => {
    const ac = new AbortController();
    const grandchild = `node -e "setInterval(()=>{},1000)" & echo $!; wait`;
    const run = shellTool.run(
      { command: grandchild, timeout: 10_000 },
      { cwd: process.cwd(), signal: ac.signal },
    );
    await new Promise((res) => setTimeout(res, 400));
    ac.abort();
    const r = await run;
    const pid = Number(/(\d+)/.exec(r.content)?.[1]);
    if (pid > 0) {
      await new Promise((res) => setTimeout(res, 300));
      expect(alive(pid)).toBe(false);
    }
  }, 15_000);
});

/**
 * A `cd` that leaves this session's working directory.
 *
 * The system prompt already says it — "You are already in `<cwd>` … do not `cd` elsewhere" — and an
 * instruction is advice. Measured live, verbatim, from an implementer inside its own task worktree:
 *
 *   cd /Users/…/parrot/src/infra.persistence.postgre && dotnet ef migrations add AddCompanyAssociation
 *
 * It walked into the DEVELOPER'S checkout by absolute path and generated 1.4 MB of migration there. The
 * developer's tree was dirtied, and — the worse cost — the work landed outside the worktree the review
 * reads, so the change would have been judged with a hole in it.
 */
describe("a command that walks out of the working directory", () => {
  const CWD = "/w/.horsecode/worktrees/mon_01/tasks/company-association";

  it("catches the command that was actually run", async () => {
    const { leavesWorkdir } = await import("../../src/tools/shell.js");
    expect(leavesWorkdir(
      "cd /Users/x/parrot/src/infra.persistence.postgre && dotnet ef migrations add AddCompanyAssociation",
      CWD,
    )).toBeTruthy();
  });

  /** Driving a monorepo from a subdirectory is ordinary and must keep working. */
  it("allows a cd DOWN into the tree", async () => {
    const { leavesWorkdir } = await import("../../src/tools/shell.js");
    expect(leavesWorkdir("cd toucan && npx nx build beempa", CWD)).toBeUndefined();
    expect(leavesWorkdir("cd ./src/api && dotnet build", CWD)).toBeUndefined();
  });

  it("follows the directory across a chain, so a climb back out is caught", async () => {
    const { leavesWorkdir } = await import("../../src/tools/shell.js");
    expect(leavesWorkdir("cd toucan && cd ../../.. && ls", CWD)).toBeTruthy();
    expect(leavesWorkdir("cd toucan && cd .. && ls", CWD)).toBeUndefined();  // back to the root of the tree
  });

  it("treats going home as leaving, however it is spelled", async () => {
    const { leavesWorkdir } = await import("../../src/tools/shell.js");
    for (const c of ["cd", "cd ~", "cd $HOME", "cd ~/parrot", "cd -"]) {
      expect(leavesWorkdir(`${c} && ls`, CWD), c).toBeTruthy();
    }
  });

  it("leaves a command with no cd in it alone", async () => {
    const { leavesWorkdir } = await import("../../src/tools/shell.js");
    expect(leavesWorkdir("dotnet build && dotnet test", CWD)).toBeUndefined();
    expect(leavesWorkdir("grep -rn 'cd ' src", CWD)).toBeUndefined();
  });

  it("refuses it through the tool, naming where the session actually is", async () => {
    const r = await shellTool.run(
      { command: "cd /Users/x/parrot/src && dotnet ef migrations add X" },
      { cwd: CWD, signal: new AbortController().signal } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain(CWD);
    expect(r.content).toMatch(/invisible to the review/);
  });
});

/**
 * A git command that DESTROYS uncommitted work, run through the door the git tool closed.
 *
 * The git tool refuses everything that writes, so "this tool never changes anything" is a guarantee it can
 * make. `shell` made no such promise and the same commands went through it. Measured over one run, all from
 * implementers cleaning up after themselves: `reset --mixed HEAD~11`, `reset --hard origin/<branch>`,
 * `checkout -- .`, `restore --source=<sha> -- .`
 */
describe("a git command that throws work away", () => {
  const CWD = "/w/base";
  const run = (command: string) =>
    shellTool.run({ command }, { cwd: CWD, signal: new AbortController().signal } as never);

  it("refuses the shapes that were actually run", async () => {
    const { destroysWork } = await import("../../src/tools/shell.js");
    expect(destroysWork("git reset --hard origin/hc/t/x")).toBeTruthy();
    expect(destroysWork("git checkout -- .")).toBeTruthy();
    expect(destroysWork("git restore --source=c2649bc64 -- .")).toBeTruthy();
    expect(destroysWork("git clean -fd")).toBeTruthy();
  });

  /** Recording work is the implementer's job; taking it away leaves it unable to finish. */
  it("leaves committing and staging alone", async () => {
    const { destroysWork } = await import("../../src/tools/shell.js");
    for (const c of ["git add src/a.cs", "git commit -m 'wip'", "git push", "git stash list",
      "git reset --mixed HEAD~1", "git status"]) {
      expect(destroysWork(c), c).toBeUndefined();
    }
  });

  /** Reverting ONE named file is an edit, and the transcript says which file. */
  it("allows a revert scoped to a path", async () => {
    const { destroysWork } = await import("../../src/tools/shell.js");
    expect(destroysWork("git checkout -- src/domain/Order.cs")).toBeUndefined();
    expect(destroysWork("git restore src/domain/Order.cs")).toBeUndefined();
  });

  it("does not fire on a command that merely mentions the words", async () => {
    const { destroysWork } = await import("../../src/tools/shell.js");
    expect(destroysWork("grep -rn 'git reset --hard' docs/")).toBeUndefined();
  });

  it("points at the checkpoint route rather than just refusing", async () => {
    const r = await run("git checkout -- .");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/wip\(…\)` checkpoint/);
    expect(r.content).toMatch(/NAMED path/);
  });
});
