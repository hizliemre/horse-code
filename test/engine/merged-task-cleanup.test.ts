import { describe, it, expect } from "vitest";

/**
 * A task that merged has nothing left to hold: its work is in the base branch.
 *
 * `removeTask` was written for exactly this and never called once — the contract note in wave-task.ts says
 * so out loud: "No branch cleans up the task worktree/branch (`removeTask`/`closeSession` → E4c)." It is the
 * same shape as `isSessionBase`, a capability written and left unwired.
 *
 * Measured on one project: 53 git worktrees, 47 of them fully merged into development, each a full checkout
 * with its own `node_modules` — removing them took minutes of pure disk work. They slow every `git worktree
 * list` the user runs, and they bury the two or three that DO still hold something.
 */
describe("a merged task lets go of its worktree", () => {
  const src = async (): Promise<string> =>
    (await import("node:fs/promises")).readFile("src/engine/wave-engine.ts", "utf8");

  it("removes it the moment the merge lands", async () => {
    const s = await src();
    const at = s.indexOf('if (res.status === "merged")');
    expect(at).toBeGreaterThan(-1);
    const block = s.slice(at, at + 1200);
    expect(block).toContain("deps.manager.removeTask(session, res.task)");
  });

  /** Untidy is not a failure: the work is merged whatever happens to the directory. */
  it("does not let a stuck directory fail a merged task", async () => {
    const s = await src();
    const at = s.indexOf("deps.manager.removeTask(session, res.task)");
    const around = s.slice(at - 60, at + 200);
    expect(around).toContain("try {");
    expect(around).toContain("catch");
  });

  /** The capability itself: worktree AND branch, or the branch list grows instead of the directory list. */
  it("removes the branch with it", async () => {
    const mgr = await (await import("node:fs/promises")).readFile("src/worktree/manager.ts", "utf8");
    const fn = mgr.slice(mgr.indexOf("async removeTask("), mgr.indexOf("async removeTask(") + 300);
    expect(fn).toContain('"worktree", "remove", "--force"');
    expect(fn).toContain('"branch", "-D"');
  });

  /** A conflicted task keeps its worktree: that is the one someone may still need to look at. */
  it("keeps the worktree of a task that did not merge", async () => {
    const s = await src();
    const at = s.indexOf('else if (res.status === "conflict"');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 600)).not.toContain("removeTask");
  });
});
