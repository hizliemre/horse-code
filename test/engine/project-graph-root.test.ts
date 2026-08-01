import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphRoot, loadGraphSync, GRAPH_DIR, GRAPH_FILE } from "../../src/engine/project-graph.js";
import { sessionBase, stateRoot, isSessionBase } from "../../src/engine/session-scope.js";

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
