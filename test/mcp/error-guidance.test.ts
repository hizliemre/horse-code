import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mcpToolAdapter, explainMcpError, isServerFault, MAX_SCHEMA_HINT } from "../../src/mcp/registry.js";
import type { McpConnection, McpTool } from "../../src/mcp/client.js";

const SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

const tool = (over: Partial<McpTool> = {}): McpTool =>
  ({ name: "list_projects", description: "Lists projects", inputSchema: SCHEMA, readOnly: true, ...over });

const failing = (message: string): McpConnection => ({
  name: "angular-cli",
  tools: [],
  callTool: async () => { throw new Error(message); },
  close: async () => { /* nothing to close */ },
});

const ctx = { cwd: "/tmp", signal: new AbortController().signal } as never;

/**
 * A terse "MCP error -32602" gives an agent nothing to act on. Either its call was wrong — in which case
 * the schema it should have matched is what it needs — or the server misbehaved, in which case the one
 * useful instruction is to stop trying.
 */
describe("isServerFault", () => {
  /** The wire code is -32602 for both, so the code alone cannot tell them apart. */
  it.each([
    "MCP error -32602: Structured content does not match the tool's output schema: data must be object",
    "invalid response from server",
    "malformed result",
  ])("recognises the server's own fault in %o", (m) => {
    expect(isServerFault(m)).toBe(true);
  });

  it.each([
    "MCP error -32602: Invalid params: 'path' is required",
    "MCP error -32602: unknown argument 'foo'",
  ])("treats %o as a bad call", (m) => {
    expect(isServerFault(m)).toBe(false);
  });
});

describe("explainMcpError", () => {
  it("hands back the schema so a bad call can be corrected and retried", () => {
    const text = explainMcpError("mcp__x__t", "Invalid params: 'path' is required", SCHEMA);
    expect(text).toContain("Invalid params");
    expect(text).toContain('"required":["path"]');
    expect(text).toMatch(/Correct them and call it again/);
  });

  /** An agent not told this retries the identical call until it runs out of turns. */
  it("tells the agent NOT to retry a server that broke its own contract", () => {
    const text = explainMcpError("mcp__x__t", "Structured content does not match the tool's output schema", SCHEMA);
    expect(text).toMatch(/repeating it will fail identically/);
    expect(text).not.toMatch(/call it again/);
  });

  it("says the tool is broken, so the answer can report it", () => {
    const text = explainMcpError("mcp__x__t", "output schema mismatch", SCHEMA);
    expect(text).toMatch(/say in your answer that this tool is broken/);
  });

  it("caps an enormous schema rather than flooding the turn", () => {
    const huge = { type: "object", properties: Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`field_${i}`, { type: "string", description: "a field" }])) };
    expect(explainMcpError("t", "Invalid params", huge).length).toBeLessThan(MAX_SCHEMA_HINT + 200);
  });

  it("falls back to the message alone when there is no schema to give", () => {
    expect(explainMcpError("t", "Invalid params", {})).toBe("t: Invalid params");
  });

  it("survives a schema that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => explainMcpError("t", "Invalid params", circular)).not.toThrow();
  });
});

describe("the adapter uses it", () => {
  it("returns the guidance as the tool result, marked as an error", async () => {
    const adapted = mcpToolAdapter(failing("Invalid params: 'path' is required"), tool());
    const res = await adapted.run({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('"required":["path"]');
  });

  it("carries the server-fault guidance through too", async () => {
    const adapted = mcpToolAdapter(
      failing("MCP error -32602: Structured content does not match the tool's output schema"), tool());
    expect((await adapted.run({}, ctx)).content).toMatch(/repeating it will fail identically/);
  });

  it("names the tool, so the agent knows which call failed", async () => {
    const adapted = mcpToolAdapter(failing("boom"), tool());
    expect((await adapted.run({}, ctx)).content).toContain("mcp__angular-cli__list_projects");
  });
});

describe("a schema is still what the model sees up front", () => {
  it("keeps the server's input schema on the tool", () => {
    const adapted = mcpToolAdapter(failing("x"), tool());
    expect(adapted.rawSchema).toEqual(SCHEMA);
    expect(adapted.parameters).toBeInstanceOf(z.ZodType);
  });
});
