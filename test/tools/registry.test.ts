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
