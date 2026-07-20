import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/core/types.js";

const fakeTool: Tool = {
  name: "read_file",
  description: "dosya okur",
  permissionLevel: "safe",
  parameters: z.object({ path: z.string() }),
  run: async () => ({ content: "ok", isError: false }),
};

describe("ToolRegistry", () => {
  it("register + get + list çalışır", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    expect(reg.get("read_file")).toBe(fakeTool);
    expect(reg.get("yok")).toBeUndefined();
    expect(reg.list()).toEqual([fakeTool]);
  });

  it("schemas() zod parametreleri JSON Schema'ya çevirir", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool);
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("read_file");
    expect(schemas[0].description).toBe("dosya okur");
    expect(schemas[0].parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });
});
