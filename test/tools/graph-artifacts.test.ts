import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../../src/tools/read.js";
import { globTool } from "../../src/tools/glob.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "gfx-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const ctx = (): { cwd: string; signal: AbortSignal } => ({ cwd, signal: new AbortController().signal });

/**
 * Measured on a real project: a coach globbed the repository, found `graphify-out/2026-08-02/graph.json` —
 * a 250 MB backup graphify takes on every rebuild, with 325,242 mentions of a directory the user had since
 * deleted — read it, and concluded that a LIVE worktree was an abandoned backup. A stale snapshot of the
 * whole repository, readable as if it were the repository, is worse than no graph: it is confidently wrong
 * about paths that no longer exist.
 */
describe("the code graph is served by the graph tools, not read as a file", () => {
  it("keeps searches out of graphify-out", async () => {
    await mkdir(join(cwd, "graphify-out", "2026-08-02"), { recursive: true });
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "graphify-out", "2026-08-02", "graph.json"), '{"nodes":[]}', "utf8");
    await writeFile(join(cwd, "graphify-out", "graph.json"), '{"nodes":[]}', "utf8");
    await writeFile(join(cwd, "src", "a.json"), "{}", "utf8");

    const res = await globTool.run({ pattern: "**/*.json" }, ctx() as never);
    expect(res.content).toContain("src/a.json");
    expect(res.content).not.toContain("graphify-out");
  });

  it("answers a direct read with the tools that serve the current graph", async () => {
    await mkdir(join(cwd, "graphify-out"), { recursive: true });
    await writeFile(join(cwd, "graphify-out", "graph.json"), '{"nodes":[{"id":"stale"}]}', "utf8");
    const res = await readFileTool.run({ path: "graphify-out/graph.json" }, ctx() as never);
    expect(res.content).not.toContain("stale");
    expect(res.content).toMatch(/graph_overview|graph_find/);
  });

  it("covers the dated backups too, however the path is written", async () => {
    await mkdir(join(cwd, "graphify-out", "2026-08-02"), { recursive: true });
    await writeFile(join(cwd, "graphify-out", "2026-08-02", "graph.json"), '{"nodes":[{"id":"stale"}]}', "utf8");
    for (const p of ["graphify-out/2026-08-02/graph.json", "./graphify-out/2026-08-02/graph.json"]) {
      const res = await readFileTool.run({ path: p }, ctx() as never);
      expect(res.content, p).not.toContain("stale");
    }
  });

  it("still reads ordinary files", async () => {
    await writeFile(join(cwd, "notes.md"), "the real notes", "utf8");
    expect((await readFileTool.run({ path: "notes.md" }, ctx() as never)).content).toContain("the real notes");
  });
});
