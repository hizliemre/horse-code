import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphRoot, loadGraphSync, GRAPH_DIR, GRAPH_FILE } from "../../src/engine/project-graph.js";

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

/**
 * The graph describes the PROJECT, but it was looked up relative to the agent's own working directory — and
 * every task agent works in a worktree under `.horsecode/worktrees/…`, which has no `graphify-out/`. So the
 * agents the graph exists for were exactly the ones that could never see it: measured on a real project, the
 * root loads 55081 nodes and the task worktree loads nothing, and the tools reported "no code graph has been
 * built for this project yet".
 */
describe("the graph is found from anywhere inside the project", () => {
  it("resolves from a task worktree several levels down", async () => {
    await writeGraph(root, 3);
    const wt = join(root, ".horsecode", "worktrees", "job", "tasks", "some-task");
    await mkdir(wt, { recursive: true });

    expect(graphRoot(wt)).toBe(root);
    expect(loadGraphSync(wt)?.nodes).toHaveLength(3);
  });

  it("finds nothing outside a project, without walking the whole filesystem", async () => {
    const bare = join(root, "not-a-project");
    await mkdir(bare, { recursive: true });
    expect(graphRoot(bare)).toBeUndefined();
    expect(loadGraphSync(bare)).toBeUndefined();
  });

  it("stops at the NEAREST project when one contains another", async () => {
    await writeGraph(root, 3);
    const inner = join(root, "packages", "inner");
    await writeGraph(inner, 7);
    expect(loadGraphSync(join(inner, "src"))?.nodes).toHaveLength(7);
  });
});

/**
 * Reading the file every call is what keeps the graph honest — a rebuild is visible at once. But a real
 * project's graph.json is 41 MB, and re-parsing that per tool call is seconds of blocking work per question.
 */
describe("the parsed graph is cached until the file changes", () => {
  it("returns the same parse for an unchanged file", async () => {
    await writeGraph(root, 3);
    expect(loadGraphSync(root)).toBe(loadGraphSync(root)); // identity: not re-parsed
  });

  it("re-reads once the file is rebuilt", async () => {
    await writeGraph(root, 3);
    expect(loadGraphSync(root)?.nodes).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 12)); // mtime granularity
    await writeGraph(root, 9);
    expect(loadGraphSync(root)?.nodes).toHaveLength(9); // a rebuild is visible immediately
  });
});
