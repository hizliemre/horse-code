import { describe, it, expect } from "vitest";
import { resolveMergeConflict, regenerateLockfile } from "../../src/engine/conflict.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("the base's copy is settled, then re-derived from the manifest", () => {
  /**
   * Taking the base's lockfile settles the conflict and leaves the file STALE: the branch's own dependency
   * is in `package.json` and not in the lockfile it just inherited. The manifest is the source of truth, so
   * the fix is the one command that regenerates the other — which is also the command a person would run,
   * and the one thing the resolver could never do: it was given read/write/edit and no shell at all.
   */
  it("runs the package manager and the lockfile ends up carrying the manifest's dependency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    try {
      await mkdir(join(dir, "toucan"), { recursive: true });
      await writeFile(join(dir, "toucan", "package.json"),
        JSON.stringify({ name: "t", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }), "utf8");
      await writeFile(join(dir, "toucan", "package-lock.json"), "{}", "utf8"); // the base's stale copy

      const said = await regenerateLockfile("toucan/package-lock.json", dir);
      expect(said, said).toMatch(/regenerated with `npm install --package-lock-only`/);
      const lock = await readFile(join(dir, "toucan", "package-lock.json"), "utf8");
      expect(lock).toContain("left-pad"); // …derived from the manifest, not merged by hand
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 200_000);

  it("says so plainly when it cannot regenerate, rather than implying the file is correct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    try {
      await mkdir(join(dir, "x"), { recursive: true }); // no package.json → npm fails
      await writeFile(join(dir, "x", "package-lock.json"), "{}", "utf8");
      const said = await regenerateLockfile("x/package-lock.json", dir);
      expect(said).toMatch(/could not regenerate/);
      expect(said).toMatch(/run it yourself before merging/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 200_000);

  /**
   * Yarn is deliberately absent: the command differs between Yarn 1 and Yarn 2+, the lockfile does not say
   * which, and running the wrong one rewrites it in the other format — worse than the conflict.
   */
  it("does not guess a command it cannot know", async () => {
    expect(await regenerateLockfile("yarn.lock", "/tmp")).toBeUndefined();
    expect(await regenerateLockfile("src/app.ts", "/tmp")).toBeUndefined();
  });
});

describe("a trace conflict is regenerated, not reconciled", () => {
  /**
   * Two branches both rewrote horse-code's own description of a source file — one because a task was told to
   * update the architecture doc, the other because the merge refresh re-derived it. Neither text is a
   * decision anybody made; both are accounts of the same code, and asking a model to reconcile two AI-written
   * prose descriptions is asking it to choose between paraphrases.
   *
   * Measured live: three `conflict:resolve-attempt` rounds on one `.md`, the merge still unresolved, the base
   * stuck for five minutes with `UU`.
   */
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

  it("takes the base's copy of a per-file trace and never asks a model", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "t" });
    const resolved: string[] = [];
    const asked = { n: 0 };
    const f = ".horsecode/traces/toucan/libs/pipes/safe-html.pipe.ts.md";
    const res = await resolveMergeConflict(deps([f], resolved, asked), session, board, "t1", TASK);
    expect(res.status).toBe("resolved");
    expect(resolved).toEqual([f]);
    expect(asked.n).toBe(0);
  });

  it("leaves the project's OWN documents to the resolver — those are written by people", async () => {
    const board = new Board();
    board.addCard({ id: "t1", title: "t" });
    const resolved: string[] = [];
    const asked = { n: 0 };
    // `47-orders.md` is not `<source>.<ext>.md`; it is a document the team wrote.
    await resolveMergeConflict(deps([".horsecode/traces/47-orders.md"], resolved, asked), session, board, "t1", TASK)
      .catch(() => { /* the stub is incomplete past the resolver, which is the point */ });
    expect(resolved).toEqual([]);
  });
});
