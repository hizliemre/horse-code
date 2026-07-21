import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../src/tools/index.js";

describe("createDefaultRegistry", () => {
  it("registers the 7 MVP tools with correct permission levels", () => {
    const reg = createDefaultRegistry();
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual(
      ["edit_file", "glob", "grep", "read_file", "shell", "web_fetch", "write_file"].sort(),
    );
    expect(reg.get("read_file")?.permissionLevel).toBe("safe");
    expect(reg.get("write_file")?.permissionLevel).toBe("write");
    expect(reg.get("shell")?.permissionLevel).toBe("exec");
  });

  it("schemas() produces a name + JSON Schema for each tool", () => {
    const reg = createDefaultRegistry();
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(7);
    for (const s of schemas) {
      expect(typeof s.name).toBe("string");
      expect(s.parameters).toMatchObject({ type: "object" });
    }
  });
});
