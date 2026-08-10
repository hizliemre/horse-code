import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import { buildFindToolTool, scoreTool, MAX_FOUND } from "../../src/tools/find-tool.js";
import { deferMcp } from "../../src/engine/reviewer.js";
import type { Tool } from "../../src/core/types.js";

const t = (name: string, description: string): Tool => ({
  name, description,
  permissionLevel: "safe",
  parameters: z.object({}),
  rawSchema: { type: "object" },
  run: async () => ({ content: "ok", isError: false }),
});
const ctx = { cwd: "/tmp", signal: new AbortController().signal } as never;

const PROJECT = [
  t("mcp__ado__repo_pull_request", "[MCP:ado] Read a pull request, its commits and its threads"),
  t("mcp__ado__pipelines_run", "[MCP:ado] Run a build pipeline for a branch"),
  t("mcp__ado__wit_work_item", "[MCP:ado] Read a work item"),
  t("mcp__ng__list_projects", "[MCP:ng] List the Angular projects in this workspace"),
];

describe("fetching a project tool instead of carrying all of them", () => {
  const build = (): ToolRegistry => {
    const r = new ToolRegistry();
    deferMcp(r, PROJECT);
    return r;
  };

  it("sends only the search tool until something is asked for", () => {
    expect((build().schemas() ?? []).map((s) => s.name)).toEqual(["find_tool"]);
  });

  it("makes what it finds callable from the next turn", async () => {
    const r = build();
    const res = await r.get("find_tool")!.run({ query: "pull request threads" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain("mcp__ado__repo_pull_request");
    expect((r.schemas() ?? []).map((s) => s.name)).toContain("mcp__ado__repo_pull_request");
  });

  it("takes an exact name", async () => {
    const r = build();
    await r.get("find_tool")!.run({ query: "mcp__ng__list_projects" }, ctx);
    const sent = (r.schemas() ?? []).map((s) => s.name);
    expect(sent).toContain("mcp__ng__list_projects");
    // …and does not open the whole catalogue on the way.
    expect(sent).not.toContain("mcp__ado__wit_work_item");
  });

  /** A vague query must not undo the saving by opening everything. */
  it("opens at most a handful at a time", async () => {
    const many = Array.from({ length: 40 }, (_, i) => t(`mcp__s__build_${i}`, "[MCP:s] build something"));
    const r = new ToolRegistry();
    deferMcp(r, many);
    await r.get("find_tool")!.run({ query: "build" }, ctx);
    expect((r.schemas() ?? []).length - 1).toBeLessThanOrEqual(MAX_FOUND);
  });

  it("says what there is when nothing matches, rather than nothing", async () => {
    const r = build();
    const res = await r.get("find_tool")!.run({ query: "kubernetes deployment rollout" }, ctx);
    expect(res.content).toContain("mcp__ado__repo_pull_request");
    expect((r.schemas() ?? []).map((s) => s.name)).toEqual(["find_tool"]);
  });

  it("is not offered to an agent with no project tools", () => {
    const r = new ToolRegistry();
    deferMcp(r, []);
    expect(r.get("find_tool")).toBeUndefined();
  });

  /** The name is what the caller meant; the prose around it is only context. */
  it("ranks a name match above a description match", () => {
    const byName = scoreTool(t("mcp__ado__pipelines_run", "does a thing"), "pipelines");
    const byDesc = scoreTool(t("mcp__ado__other", "runs pipelines for you"), "pipelines");
    expect(byName).toBeGreaterThan(byDesc);
  });
});

/** The loop has to re-read the registry each turn, or a fetched tool could never be called. */
describe("when the schemas are read", () => {
  it("is once per turn, not once per run", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/agent/loop.ts", "utf8");
    expect(src).toContain("tools: opts.tools.schemas()");
    expect(src).not.toContain("const schemas = opts.tools.schemas();");
  });
});
