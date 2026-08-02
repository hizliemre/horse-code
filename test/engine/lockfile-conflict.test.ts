import { describe, it, expect } from "vitest";
import { resolveMergeConflict } from "../../src/engine/conflict.js";
import { Board } from "../../src/board/board.js";

/**
 * Measured on a real board: T006 conflicted on `toucan/package-lock.json` twice, and both attempts ended
 * with "maximum turn count exceeded (12)" — the task's own review had already passed. Twelve turns, twice,
 * spent hand-merging a file nobody wrote.
 *
 * A lockfile is the output of a resolver, not a document. Its conflicts are thousands of lines of
 * machine-written JSON whose correct resolution is "run the package manager again".
 */
describe("a lockfile conflict is regenerated, not merged", () => {
  const session = { baseWorktree: "/tmp/x", baseBranch: "hc/j/base", jobSlug: "j", root: "/tmp" } as never;
  const TASK = { taskSlug: "t1", worktree: "/tmp/t1", branch: "hc/j/t1" } as never;

  const deps = (unmerged: string[], resolved: string[], asked: { n: number }) => ({
    manager: {
      unmergedFiles: async () => unmerged,
      commitMerge: async () => {},
      abortMerge: async () => {},
      resolveWithBase: async (_s: unknown, f: string) => { resolved.push(f); },
    },
    rounds: 1,
    note: () => {},
    provider: { async *chat() { asked.n++; yield { type: "done", finishReason: "stop" } as never; } },
    roleRegistry: { resolve: () => ({ model: "m", systemPrompt: "p" }) },
    permission: { check: () => "allow" },
    approve: async () => true,
    signal: new AbortController().signal,
  }) as never;

  it("takes the base's copy and never calls a model", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "t" });
    const resolved: string[] = [];
    const asked = { n: 0 };
    const res = await resolveMergeConflict(deps(["toucan/package-lock.json"], resolved, asked), session, board, "t1", TASK);
    expect(res.status).toBe("resolved");
    expect(resolved).toEqual(["toucan/package-lock.json"]);
    expect(asked.n).toBe(0); // no model was asked to hand-merge generated JSON
  });

  it("covers the other package managers' lockfiles too", async () => {
    for (const f of ["yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "Gemfile.lock", "poetry.lock"]) {
      const board = new Board();
      board.addCard({ id: "t1", title: "t" });
      const resolved: string[] = [];
      const asked = { n: 0 };
      const res = await resolveMergeConflict(deps([f], resolved, asked), session, board, "t1", TASK);
      expect(res.status, f).toBe("resolved");
      expect(asked.n, f).toBe(0);
    }
  });

  /**
   * A mixed conflict must not be short-circuited: the lockfile is settled deterministically, and the source
   * file still goes to the resolver for judgement. The stub here is deliberately incomplete past that point,
   * so reaching the resolver is what the throw proves.
   */
  it("settles the lockfile but still sends a real source conflict on to the resolver", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "t" });
    const resolved: string[] = [];
    const asked = { n: 0 };
    await expect(
      resolveMergeConflict(deps(["src/app.ts", "package-lock.json"], resolved, asked), session, board, "t1", TASK),
    ).rejects.toThrow(); // …it went on to the resolver rather than returning "resolved"
    expect(resolved).toEqual(["package-lock.json"]);
  });
});
