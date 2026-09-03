import { describe, it, expect } from "vitest";
import { changedPaths, reconcileTouched } from "../../src/engine/touched.js";
import type { GitRunner } from "../../src/worktree/git.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const git = (stdout: string, code = 0): GitRunner => async () => ({ stdout, stderr: "", code });

/**
 * `onWrite` fires for `write_file` and `edit_file` and for nothing else.
 *
 * A file produced by a `shell` call — a generator, a formatter, `npm init`, a migration tool — never reached
 * the record: not credited to the memory that predicted it, and not checkpointed, so an attempt stopped at
 * its deadline lost exactly the work no tool personally wrote. It is also the only way a DELEGATED
 * implementer can be accounted for at all, since an official CLI writing in the worktree fires no `onWrite`
 * in this process. Asking git is the one question whose answer is the same whichever agent did the work.
 */
describe("what git says an attempt changed", () => {
  it("reads added, modified and untracked paths", async () => {
    const out = await changedPaths("/w", git(" M src/a.ts\nA  src/b.ts\n?? src/c.ts\n"));
    expect(out).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  /** A rename has two paths and only one of them exists — the new one is what a memory anchors to. */
  it("takes the destination of a rename", async () => {
    expect(await changedPaths("/w", git("R  src/old.ts -> src/new.ts\n"))).toEqual(["src/new.ts"]);
  });

  /** The quotes are git's, not the filename's. */
  it("unquotes a path git had to quote", async () => {
    expect(await changedPaths("/w", git('?? "src/a b.ts"\n'))).toEqual(["src/a b.ts"]);
  });

  it("reports nothing when git itself failed", async () => {
    expect(await changedPaths("/w", git("whatever", 1))).toEqual([]);
  });

  it("reports nothing for a clean tree", async () => {
    expect(await changedPaths("/w", git(""))).toEqual([]);
  });
});

describe("reconciling what the tools saw with what happened", () => {
  const deps = {} as TaskCycleDeps;

  it("adds only what no tool already recorded", async () => {
    const touched = ["src/a.ts"];
    const extra = await reconcileTouched(deps, "/w", touched, git(" M src/a.ts\n?? src/generated.ts\n"));
    expect(extra).toEqual(["src/generated.ts"]);
    expect(touched).toEqual(["src/a.ts", "src/generated.ts"]);
  });

  /** The delegated case: the CLI wrote everything, so the tool layer recorded nothing at all. */
  it("credits an attempt whose writes all happened in another process", async () => {
    const touched: string[] = [];
    const extra = await reconcileTouched(deps, "/w", touched, git("A  src/x.ts\nA  src/y.ts\n"));
    expect(extra).toEqual(["src/x.ts", "src/y.ts"]);
    expect(touched).toEqual(["src/x.ts", "src/y.ts"]);
  });

  it("adds nothing when the tools already saw it all", async () => {
    const touched = ["src/a.ts"];
    expect(await reconcileTouched(deps, "/w", touched, git(" M src/a.ts\n"))).toEqual([]);
  });

  /** A reconciliation that fails must not fail the attempt that produced the work. */
  it("stays quiet when git cannot answer", async () => {
    const touched = ["src/a.ts"];
    const boom: GitRunner = async () => { throw new Error("not a repository"); };
    expect(await reconcileTouched(deps, "/w", touched, boom)).toEqual([]);
    expect(touched).toEqual(["src/a.ts"]);
  });
});
