import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unfinishedSessions, describeUnfinished } from "../../src/engine/unfinished.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-unfin-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const session = async (id: string, cp: Record<string, unknown>, cards?: unknown[]): Promise<void> => {
  const s = join(dir, ".horsecode", "worktrees", id);
  await mkdir(join(s, "base"), { recursive: true });
  await writeFile(join(s, "checkpoint.json"), JSON.stringify(cp), "utf8");
  if (cards) await writeFile(join(s, "board.json"), JSON.stringify({ cards }), "utf8");
};
const CP = {
  rawPrompt: "sıradaki adım nedir?", refinedPrompt: "What is the next step?", title: "wizard-testing",
  language: "Turkish", featureSlug: "", done: ["constitution", "spec", "plan"],
};

/**
 * A run's work is on its own branch in its own worktree, and nothing said so.
 *
 * Measured live: a session stopped with 126 commits and 11 of 12 tasks finished, and the next session's coach
 * — standing in the project checkout — answered "I could not find a clear task trail from the last session",
 * then listed four unrelated pull requests and asked which was meant. It was reasoning correctly from what it
 * could see; the answer was three directories away, in a checkpoint file written for exactly this.
 */
describe("finding what a previous run left behind", () => {
  it("reads the checkpoint, the board and the branch", async () => {
    await session("07-Aug", CP, [{ column: "MERGED" }, { column: "MERGED" }, { column: "TODO" }]);
    const [s] = unfinishedSessions(dir, () => 126);
    expect(s.id).toBe("07-Aug");
    expect(s.checkpoint.rawPrompt).toBe("sıradaki adım nedir?");
    expect(s.cards).toEqual({ total: 3, done: 2 });
    expect(s.commits).toBe(126);
  });

  /** A session whose worktree is gone has nothing to go back to; one with no checkpoint never started. */
  it("skips what cannot be continued", async () => {
    const bare = join(dir, ".horsecode", "worktrees", "no-worktree");
    await mkdir(bare, { recursive: true });
    await writeFile(join(bare, "checkpoint.json"), JSON.stringify(CP), "utf8");
    await mkdir(join(dir, ".horsecode", "worktrees", "no-checkpoint", "base"), { recursive: true });
    expect(unfinishedSessions(dir)).toEqual([]);
  });

  it("says nothing about a project that has never run one", async () => {
    expect(unfinishedSessions(dir)).toEqual([]);
  });

  /** The line leads with the user's OWN words: the refined prompt is English and the id is a filename. */
  it("describes it in the words the user will recognise", async () => {
    await session("07-Aug", CP, [{ column: "MERGED" }, { column: "TODO" }]);
    const line = describeUnfinished(unfinishedSessions(dir, () => 126)[0]);
    expect(line).toContain("sıradaki adım nedir?");
    expect(line).toContain("constitution → spec → plan done");
    expect(line).toContain("1/2 tasks");
    expect(line).toContain("126 commits");
    expect(line).toContain("07-Aug");
  });

  it("survives a board it cannot read", async () => {
    const s = join(dir, ".horsecode", "worktrees", "broken");
    await mkdir(join(s, "base"), { recursive: true });
    await writeFile(join(s, "checkpoint.json"), JSON.stringify(CP), "utf8");
    await writeFile(join(s, "board.json"), "{ not json", "utf8");
    expect(unfinishedSessions(dir)[0].cards).toEqual({ total: 0, done: 0 });
  });
});

/** The coach stands in the checkout; the work is elsewhere. It needs to be able to look. */
describe("what the coach can ask about earlier work", () => {
  it("is a tool it actually has", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/reviewer.ts", "utf8");
    expect(src).toContain("r.register(findUnfinishedTool);");
    // Same gate as the write tool: the coach is the role the user talks to, and the only one that needs this.
    expect(src).toContain("if (opts.gitWrite) {");
  });

  it("hands back the worktree path, not just a summary", async () => {
    const { findUnfinishedTool } = await import("../../src/tools/unfinished-tool.js");
    await session("07-Aug", CP, [{ column: "MERGED" }]);
    const r = await findUnfinishedTool.run({}, { cwd: dir, signal: new AbortController().signal } as never);
    expect(r.content).toContain("sıradaki adım nedir?");
    expect(r.content).toContain(join(dir, ".horsecode", "worktrees", "07-Aug", "base"));
    expect(r.content).toContain("hc/07-Aug/base");
  });

  it("says so plainly when there is nothing to continue", async () => {
    const { findUnfinishedTool } = await import("../../src/tools/unfinished-tool.js");
    const r = await findUnfinishedTool.run({}, { cwd: dir, signal: new AbortController().signal } as never);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/no unfinished session/i);
  });
});
