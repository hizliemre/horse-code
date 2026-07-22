import { describe, it, expect } from "vitest";
import { mcpToolName, mcpToolAdapter } from "../../src/mcp/registry.js";
import type { McpConnection } from "../../src/mcp/client.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

const fakeConn = (over: Partial<McpConnection> = {}): McpConnection => ({
  name: "fs",
  tools: [],
  callTool: async (tool, args) => ({ content: `called ${tool} ${JSON.stringify(args)}`, isError: false }),
  close: async () => {},
  ...over,
});

describe("mcpToolName", () => {
  it("prefixes + sanitizes to an API-safe name", () => {
    expect(mcpToolName("fs", "read_file")).toBe("mcp__fs__read_file");
    expect(mcpToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
  });
});

describe("mcpToolAdapter", () => {
  it("wraps an MCP tool: exec-level, rawSchema = the server's inputSchema, run → callTool", async () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const tool = mcpToolAdapter(fakeConn(), { name: "read_file", description: "reads a file", inputSchema: schema });
    expect(tool.name).toBe("mcp__fs__read_file");
    expect(tool.permissionLevel).toBe("exec");
    expect(tool.rawSchema).toBe(schema);
    expect(tool.description).toContain("[MCP:fs]");
    expect(tool.describe?.({ path: "a.ts" }).allowKey).toBe("mcp:fs:read_file");
    const res = await tool.run({ path: "a.ts" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("called read_file");
    expect(res.content).toContain("a.ts");
  });

  it("surfaces a call error as an error result (never throws)", async () => {
    const conn = fakeConn({ callTool: async () => { throw new Error("server crashed"); } });
    const tool = mcpToolAdapter(conn, { name: "boom", inputSchema: {} });
    const res = await tool.run({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("server crashed");
  });
});
