import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphRoot, loadGraphSync, graphStatus, pruneTooling, failureReason, GRAPH_DIR, GRAPH_FILE } from "../../src/engine/project-graph.js";
import { sessionBase, stateRoot, isSessionBase } from "../../src/engine/session-scope.js";
import { initTmpRepo } from "../worktree/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hc-graph-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const GRAPH = (n: number): string => JSON.stringify({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `sym${i}`, source_file: "a.ts" })),
  links: [],
});
const writeGraph = async (dir: string, n: number): Promise<void> => {
  await mkdir(join(dir, GRAPH_DIR), { recursive: true });
  await writeFile(join(dir, GRAPH_DIR, GRAPH_FILE), GRAPH(n), "utf8");
};
const sessionOf = (job: string): { base: string; task: string } => ({
  base: join(root, ".horsecode", "worktrees", job, "base"),
  task: join(root, ".horsecode", "worktrees", job, "tasks", "some-task"),
});

/**
 * A run's state has to live inside the run. The project root is a reference: anything read from — or written
 * to — outside the session never reaches the pull request the run exists to produce, so a lesson a task
 * learned would be saved where nobody reviews it and nobody receives it.
 */
describe("project state is scoped to the session, not the project root", () => {
  it("gives a task worktree the graph from its OWN session base", async () => {
    const { base, task } = sessionOf("job-a");
    await writeGraph(base, 5);
    await mkdir(task, { recursive: true });
    expect(sessionBase(task)).toBe(base);
    expect(loadGraphSync(task)?.nodes).toHaveLength(5);
  });

  it("does NOT reach past the session to the project root", async () => {
    const { base, task } = sessionOf("job-a");
    await writeGraph(root, 99);          // the root has one…
    await mkdir(base, { recursive: true }); // …and the session does not
    await mkdir(task, { recursive: true });
    expect(loadGraphSync(task)).toBeUndefined();
    expect(graphRoot(task)).toBeUndefined();
  });

  it("keeps two concurrent sessions apart", async () => {
    const a = sessionOf("job-a"), b = sessionOf("job-b");
    await writeGraph(a.base, 3);
    await writeGraph(b.base, 8);
    await mkdir(a.task, { recursive: true });
    await mkdir(b.task, { recursive: true });
    expect(loadGraphSync(a.task)?.nodes).toHaveLength(3);
    expect(loadGraphSync(b.task)?.nodes).toHaveLength(8);
  });

  it("reads its own directory when there is no session — the REPL at the project root", async () => {
    await writeGraph(root, 4);
    expect(sessionBase(root)).toBeUndefined();
    expect(stateRoot(root)).toBe(root);
    expect(loadGraphSync(root)?.nodes).toHaveLength(4);
  });

  it("recognises the base itself as the one place a run may write", async () => {
    const { base, task } = sessionOf("job-a");
    expect(isSessionBase(base)).toBe(true);
    expect(isSessionBase(task)).toBe(false);
    expect(isSessionBase(root)).toBe(false);
  });
});

/** Re-parsing a 41 MB graph per tool call is seconds of blocking work; the mtime keeps it honest. */
describe("the parsed graph is cached until the file changes", () => {
  it("returns the same parse for an unchanged file", async () => {
    await writeGraph(root, 3);
    expect(loadGraphSync(root)).toBe(loadGraphSync(root));
  });

  it("re-reads once the file is rebuilt", async () => {
    await writeGraph(root, 3);
    expect(loadGraphSync(root)?.nodes).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 12));
    await writeGraph(root, 9);
    expect(loadGraphSync(root)?.nodes).toHaveLength(9);
  });
});

describe("graphStatus — staleness is a claim about the PROJECT's code", () => {
  /** A real repository: `git ls-files` is what feeds the check, so a bare temp dir proves nothing. */
  const repo = async (): Promise<string> => {
    const r = await initTmpRepo();
    await mkdir(join(r, GRAPH_DIR), { recursive: true });
    await mkdir(join(r, "src"), { recursive: true });
    await mkdir(join(r, ".horsecode", "skills", "x"), { recursive: true });
    await writeFile(join(r, "src", "a.ts"), "export const a = 1;", "utf8");
    await writeFile(join(r, ".horsecode", "skills", "x", "SKILL.md"), "skill", "utf8");
    await writeFile(join(r, GRAPH_DIR, GRAPH_FILE), JSON.stringify({
      nodes: [{ id: "1", label: "a", source_file: "src/a.ts" },
              { id: "2", label: "skill", source_file: ".horsecode/skills/x/SKILL.md" }],
      links: [],
    }), "utf8");
    return r;
  };

  /**
   * The check used to scan every code-looking file git reported. On a real project that made the graph
   * "stale" because of scripts under `.claude/skills/` — which graphify never indexed — and then, once the
   * graph's own file list was used, because of `.horsecode/skills/**.md`, which it HAD indexed, only because
   * graphify walks whatever it is pointed at. Both told the user to spend a rebuild that would change nothing.
   */
  it("is not made stale by tooling directories, indexed or not", async () => {
    const r = await repo();
    try {
      await new Promise((res) => setTimeout(res, 20));
      await writeFile(join(r, ".horsecode", "skills", "x", "SKILL.md"), "changed", "utf8");
      const st = await graphStatus(r);
      expect(st.built).toBe(true);
      expect(st.staleBecause).toEqual([]);
      expect(st.stale).toBe(false);
    } finally { await rm(r, { recursive: true, force: true }); }
  });

  it("still reports stale when the project's own code changes", async () => {
    const r = await repo();
    try {
      await new Promise((res) => setTimeout(res, 20));
      await writeFile(join(r, "src", "a.ts"), "export const a = 2;", "utf8");
      const st = await graphStatus(r);
      expect(st.staleBecause).toContain("src/a.ts");
      expect(st.stale).toBe(true);
    } finally { await rm(r, { recursive: true, force: true }); }
  });
});

describe("pruneTooling — the graph is the project, not what is installed in it", () => {
  /**
   * graphify walks what it is pointed at, and that includes horse-code's own state. Measured on a real
   * project: 7,915 of 55,081 nodes came from `.horsecode/skills`, `.claude/` and `.agents/` — 14% of a graph
   * that is now committed, surfacing skill documents in `graph_find` as though they were source files.
   */
  it("drops tooling nodes and keeps the project's own", () => {
    const doc: Record<string, unknown> = {
      nodes: [
        { id: "1", source_file: "src/api/orders.ts" },
        { id: "2", source_file: ".horsecode/skills/x/SKILL.md" },
        { id: "3", source_file: ".claude/agents/y.md" },
        { id: "4", source_file: ".agents/z.md" },
        { id: "5", source_file: "node_modules/left-pad/index.js" },
      ],
      links: [{ source: "1", target: "2" }, { source: "1", target: "1" }],
      directed: true,
    };
    const r = pruneTooling(doc);
    expect(r).toEqual({ removed: 4, kept: 1 });
    expect((doc.nodes as { id: string }[]).map((n) => n.id)).toEqual(["1"]);
    // An edge into a node that is gone is worse than the node: every traversal then has to guard against it.
    expect(doc.links).toEqual([{ source: "1", target: "1" }]);
    expect(doc.directed).toBe(true); // everything else the serializer wrote is left alone
  });

  it("keeps nodes that name no file — they are not claims about a path", () => {
    const doc: Record<string, unknown> = { nodes: [{ id: "1" }, { id: "2", source_file: "src/a.ts" }], links: [] };
    expect(pruneTooling(doc).removed).toBe(0);
  });

  it("is idempotent — the next incremental build re-adds them and this takes them out again", () => {
    const doc: Record<string, unknown> = {
      nodes: [{ id: "1", source_file: "src/a.ts" }, { id: "2", source_file: ".horsecode/skills/s.md" }],
      links: [],
    };
    expect(pruneTooling(doc).removed).toBe(1);
    expect(pruneTooling(doc).removed).toBe(0);
  });
});

describe("failureReason — a failed build has to say why", () => {
  /**
   * The report was the last three lines of output. On a real project those were progress lines, so a build
   * that had been SIGKILLed at 98% told the user: "Graph build failed: AST extraction: 19297/19297 files
   * (100%)". Complete, and useless — the same shape of mistake as printing every rule at launch.
   */
  it("prefers a diagnosis over the tail of the progress log", () => {
    const out = [
      "  AST extraction: 100/19297 files (1%)",
      "Traceback (most recent call last):",
      "  File \"graphify/watch.py\", line 42, in _rebuild_code",
      "MemoryError",
      "  AST extraction: 19200/19297 files (99%)",
      "  AST extraction: 19297/19297 files (100%)",
    ].join("\n");
    const r = failureReason(out);
    expect(r).toContain("MemoryError");
    expect(r).not.toContain("19297/19297");
  });

  it("falls back to the tail when nothing looks like a diagnosis", () => {
    expect(failureReason("  AST extraction: 1/2 files\n  AST extraction: 2/2 files"))
      .toContain("2/2");
  });

  it("never treats a progress line as the diagnosis, however it is worded", () => {
    const out = [
      "  AST extraction: 5/5 files (100%) [10 workers] Error budget nominal",
      "PermissionError: [Errno 13] cannot read src/secret.ts",
    ].join("\n");
    const r = failureReason(out);
    expect(r).toContain("PermissionError");
    expect(r).not.toContain("AST extraction");
  });
});
