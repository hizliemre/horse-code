import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";
import { REVISION_CARD } from "../../src/engine/revision.js";
import { runReady } from "../../src/engine/wave-engine.js";

/**
 * `__revision__` records the PR revision rounds on the board. It is bookkeeping: no worktree, no
 * deliverable. Handed to the wave engine it becomes a task, and the coder that picks it up writes straight
 * into the BASE worktree while other tasks are still merging into it.
 *
 * Measured on a real run: the card sat in REVIEW, a resume reopened it, the engine scheduled it, and
 * "coder · PR revision: …" ran interleaved with the wave. The base was left mid-merge and the next task's
 * merge died — `fatal: You have not concluded your merge (MERGE_HEAD exists)` — taking the run with it.
 */
describe("the revision row is not a task", () => {
  it("is never scheduled by the wave engine", async () => {
    const board = new Board();
    board.addCard({ id: REVISION_CARD, title: "PR revision" });
    const started: string[] = [];
    const deps = {
      manager: { deriveTask: async () => { started.push("x"); throw new Error("must not run"); } },
      serialize: <T>(f: () => Promise<T>) => f(),
    } as never;
    await runReady(deps, { baseWorktree: "/tmp", baseBranch: "b", jobSlug: "j", root: "/tmp" } as never, board)
      .catch(() => { /* the point is that nothing was started */ });
    expect(started).toEqual([]);
    expect(board.get(REVISION_CARD)!.column).toBe("TODO"); // untouched, not driven
  });

  it("keeps its own id, so the two places that must skip it agree", () => {
    expect(REVISION_CARD).toBe("__revision__");
  });
});
