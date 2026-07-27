import { describe, it, expect } from "vitest";
import { computeWaves, validateWaves, fileClashes, splitFileConflicts, waveStats, describeWaves } from "../../src/engine/waves.js";
import { Board } from "../../src/board/board.js";

function board(cards: { id: string; deps?: string[] }[]): Board {
  const b = new Board();
  for (const c of cards) b.addCard({ id: c.id, title: c.id, deps: c.deps });
  return b;
}

describe("computeWaves", () => {
  it("independent cards in the same wave", () => {
    expect(computeWaves(board([{ id: "a" }, { id: "b" }]))).toEqual([["a", "b"]]);
  });
  it("chain → sequential waves", () => {
    const b = board([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
    expect(computeWaves(b)).toEqual([["a"], ["b"], ["c"]]);
  });
  it("diamond: a → {b,c} → d", () => {
    const b = board([
      { id: "a" },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ]);
    expect(computeWaves(b)).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("cycle → error", () => {
    const b = board([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]);
    expect(() => computeWaves(b)).toThrow(/cycle|unresolved/);
  });
  it("empty board → empty waves", () => {
    expect(computeWaves(new Board())).toEqual([]);
  });
});

describe("validateWaves", () => {
  const chain = () => board([{ id: "a" }, { id: "b", deps: ["a"] }]);
  it("valid waves → true", () => {
    expect(validateWaves([["a"], ["b"]], chain())).toBe(true);
  });
  it("dep in the same wave → false", () => {
    expect(validateWaves([["a", "b"]], chain())).toBe(false);
  });
  it("missing/duplicate card → false", () => {
    expect(validateWaves([["a"]], chain())).toBe(false); // b missing
    expect(validateWaves([["a"], ["b"], ["a"]], chain())).toBe(false); // a duplicated
  });
});

const withFiles = (cards: { id: string; deps?: string[]; files?: string[] }[]): Board => {
  const b = new Board();
  for (const c of cards) b.addCard({ id: c.id, title: c.id, deps: c.deps, files: c.files });
  return b;
};

/**
 * `deps` is the project-manager's account of what depends on what, and nothing verifies it.
 *
 * A dependency it omits does not fail loudly — it produces two agents editing one file in separate worktrees
 * and a merge conflict hours later, resolved by a council call that only exists because the plan was wrong.
 * The task's own file list catches that before anything runs.
 */
describe("fileClashes", () => {
  it("finds two tasks that would write the same file", () => {
    const b = withFiles([{ id: "a", files: ["src/store.ts"] }, { id: "b", files: ["src/store.ts", "src/ui.ts"] }]);
    expect(fileClashes(["a", "b"], b)).toEqual([{ a: "a", b: "b", files: ["src/store.ts"] }]);
  });

  it("says nothing about tasks that touch different files", () => {
    const b = withFiles([{ id: "a", files: ["src/a.ts"] }, { id: "b", files: ["src/b.ts"] }]);
    expect(fileClashes(["a", "b"], b)).toEqual([]);
  });

  /** Over-reporting costs a little parallelism; under-reporting costs a merge conflict. Spell it generously. */
  it("treats ./src/A.ts and src/a.ts as the same file", () => {
    const b = withFiles([{ id: "a", files: ["./src/A.ts"] }, { id: "b", files: ["src/a.ts"] }]);
    expect(fileClashes(["a", "b"], b)).toHaveLength(1);
  });

  it("ignores a task that listed no files rather than guessing", () => {
    const b = withFiles([{ id: "a", files: ["src/store.ts"] }, { id: "b" }]);
    expect(fileClashes(["a", "b"], b)).toEqual([]);
  });
});

describe("splitFileConflicts", () => {
  it("separates a clashing pair into consecutive waves", () => {
    const b = withFiles([{ id: "a", files: ["src/store.ts"] }, { id: "b", files: ["src/store.ts"] }]);
    expect(splitFileConflicts([["a", "b"]], b).waves).toEqual([["a"], ["b"]]);
  });

  /** First-fit, not a serial chain: one clashing pair must not cost a wave per task. */
  it("keeps everything that does not clash together", () => {
    const b = withFiles([
      { id: "a", files: ["src/store.ts"] },
      { id: "b", files: ["src/store.ts"] },
      { id: "c", files: ["src/ui.ts"] },
      { id: "d", files: ["src/api.ts"] },
    ]);
    expect(splitFileConflicts([["a", "b", "c", "d"]], b).waves).toEqual([["a", "c", "d"], ["b"]]);
  });

  it("leaves a clean wave exactly as it was", () => {
    const b = withFiles([{ id: "a", files: ["src/a.ts"] }, { id: "b", files: ["src/b.ts"] }]);
    const waves = [["a", "b"]];
    expect(splitFileConflicts(waves, b).waves).toEqual(waves);
  });

  /**
   * The split only ever moves a task LATER, and everything it depends on was satisfied in an earlier wave —
   * so the result is still a valid schedule. Asserted rather than argued, because a scheduler that quietly
   * violates a dependency produces a build failure nobody traces back to here.
   */
  it("still satisfies every dependency after splitting", () => {
    const b = withFiles([
      { id: "a", files: ["src/store.ts"] },
      { id: "b", files: ["src/store.ts"] },
      { id: "c", deps: ["a", "b"], files: ["src/ui.ts"] },
    ]);
    const { waves } = splitFileConflicts(computeWaves(b), b);
    expect(validateWaves(waves, b)).toBe(true);
  });

  it("reports what it separated, so the run can say why it went slower", () => {
    const b = withFiles([{ id: "a", files: ["src/store.ts"] }, { id: "b", files: ["src/store.ts"] }]);
    expect(splitFileConflicts([["a", "b"]], b).clashes).toHaveLength(1);
  });

  /** A board whose file lists were never filled in must schedule exactly as it did before they existed. */
  it("changes nothing when no task lists any file", () => {
    const b = withFiles([{ id: "a" }, { id: "b" }, { id: "c", deps: ["a"] }]);
    const waves = computeWaves(b);
    expect(splitFileConflicts(waves, b).waves).toEqual(waves);
  });
});

/**
 * Nothing measured this. A plan that serializes twenty independent tasks and one that runs them in three
 * waves both report "completed", at wildly different cost, and no number anywhere told them apart.
 */
describe("waveStats", () => {
  it("measures how much actually ran in parallel", () => {
    const b = withFiles([{ id: "a" }, { id: "b" }, { id: "c", deps: ["a"] }]);
    const s = waveStats(b, [["a", "b"], ["c"]]);
    expect(s.tasks).toBe(3);
    expect(s.waves).toBe(2);
    expect(s.width).toBe(1.5);
    expect(s.widest).toBe(2);
  });

  it("counts the trouble from the board's own history", () => {
    const b = withFiles([{ id: "a" }, { id: "b" }, { id: "c" }]);
    b.appendStage("a", { role: "team-lead", action: "merge-conflict" });
    b.appendStage("b", { role: "team-lead", action: "task-failed" });
    b.appendStage("c", { role: "team-lead", action: "skipped" });
    const s = waveStats(b, [["a", "b", "c"]]);
    expect(s.conflicts).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.skipped).toBe(1);
  });

  it("counts a task that had to be redone", () => {
    const b = withFiles([{ id: "a" }, { id: "b" }]);
    b.incrementAttempts("a"); b.incrementAttempts("a");
    b.incrementAttempts("b");
    const s = waveStats(b, [["a", "b"]]);
    expect(s.escalated).toBe(1); // only `a` went round more than once
    expect(s.attempts).toBe(3);
  });

  it("does not divide by zero on an empty board", () => {
    expect(waveStats(new Board(), []).width).toBe(0);
  });
});

describe("describeWaves", () => {
  it("always states the shape of the run", () => {
    const b = withFiles([{ id: "a" }, { id: "b" }]);
    expect(describeWaves(waveStats(b, [["a", "b"]]))).toContain("2 task in 1 wave(s)");
  });

  // A clean run should read as one clean line, not a list of zeroes.
  it("mentions only the trouble that happened", () => {
    const b = withFiles([{ id: "a" }]);
    const line = describeWaves(waveStats(b, [["a"]]));
    expect(line).not.toContain("failed");
    expect(line).not.toContain("conflict");
  });

  it("names a file clash when one forced tasks apart", () => {
    const b = withFiles([{ id: "a", files: ["s.ts"] }, { id: "b", files: ["s.ts"] }]);
    const { waves, clashes } = splitFileConflicts([["a", "b"]], b);
    expect(describeWaves(waveStats(b, waves, clashes))).toContain("1 file clash");
  });
});
