import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/core/types.js";

const fakeTool: Tool = {
  name: "read_file",
  description: "reads a file",
  permissionLevel: "safe",
  parameters: z.object({ path: z.string() }),
  run: async () => ({ content: "ok", isError: false }),
};

describe("ToolRegistry", () => {
  it("register + get + list work", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    expect(reg.get("read_file")).toBe(fakeTool);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.list()).toEqual([fakeTool]);
  });

  it("schemas() converts zod parameters to JSON Schema", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("read_file");
    expect(schemas[0].description).toBe("reads a file");
    expect(schemas[0].parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  it("schemas() sends rawSchema verbatim when present (MCP tools)", () => {
    const raw = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const reg = new ToolRegistry();
    reg.register({ ...fakeTool, name: "mcp__x__search", rawSchema: raw, parameters: z.record(z.string(), z.unknown()) });
    expect(reg.schemas()[0].parameters).toBe(raw); // verbatim, not derived from zod
  });
});

const mcpTool = (name: string, description: string): Tool => ({
  name, description,
  permissionLevel: "safe",
  parameters: z.object({ q: z.string() }),
  rawSchema: { type: "object", properties: { q: { type: "string" } } },
  run: async () => ({ content: "ok", isError: false }),
});

/**
 * A schema is paid for on every turn, used or not.
 *
 * Measured across twelve runs of a real project: 49 project tool schemas came to 86,620 characters (~21,655
 * tokens), 242 model calls carried them, and that is ~5.2M of the 21.7M input tokens actually billed — 24% of
 * everything — for FIVE tool calls, of two distinct tools. The gateway does not honour prompt caching
 * (measured: an identical 7,438-token prefix billed 5,438 tokens on four consecutive calls, with and without
 * `cache_control`), so it is paid in full every single turn.
 */
describe("tools whose schemas are withheld until asked for", () => {
  const build = (): ToolRegistry => {
    const r = new ToolRegistry();
    r.register(fakeTool);
    r.registerDeferred(mcpTool("mcp__ado__repo_pull_request", "[MCP:ado] Read a pull request"));
    r.registerDeferred(mcpTool("mcp__ado__pipelines_run", "[MCP:ado] Run a build pipeline"));
    return r;
  };
  const names = (r: ToolRegistry): string[] => (r.schemas() ?? []).map((s) => s.name);

  it("keeps them out of what the model is sent", () => {
    expect(names(build())).toEqual(["read_file"]);
  });

  /** A model that reads the catalogue and calls the name straight off is right; refusing it teaches nothing. */
  it("still lets them be called by name", () => {
    expect(build().get("mcp__ado__pipelines_run")?.name).toBe("mcp__ado__pipelines_run");
  });

  it("hands them over once surfaced, and says which were new", () => {
    const r = build();
    expect(r.surface(["mcp__ado__pipelines_run"])).toEqual(["mcp__ado__pipelines_run"]);
    expect(names(r)).toEqual(["read_file", "mcp__ado__pipelines_run"]);
    // Already open, and one that was never deferred: neither is news.
    expect(r.surface(["mcp__ado__pipelines_run", "read_file"])).toEqual([]);
  });

  it("lists what is left to fetch", () => {
    const r = build();
    r.surface(["mcp__ado__pipelines_run"]);
    expect(r.deferredTools().map((t) => t.name)).toEqual(["mcp__ado__repo_pull_request"]);
  });

  /**
   * The schemas are read once per TURN now, so the derivation has to be cached — and the cache has to notice
   * a tool arriving, or a fetched tool could never become callable and fetching it would be pointless.
   */
  it("reuses the derivation until the contents change", () => {
    const r = build();
    expect(r.schemas()).toBe(r.schemas());
    r.surface(["mcp__ado__pipelines_run"]);
    expect(names(r)).toContain("mcp__ado__pipelines_run");
    const after = r.schemas();
    r.register(mcpTool("extra", "another"));
    expect(r.schemas()).not.toBe(after);
  });
});
