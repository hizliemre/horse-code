import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../src/tools/index.js";

describe("createDefaultRegistry", () => {
  // `git` joined the set: see test/tools/what-agents-carry.test.ts — 58 of the 62 agents that used shell in
  // one run never called the git tool, because the default registry did not carry it.
  it("registers the base tools with correct permission levels", () => {
    const reg = createDefaultRegistry();
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual(
      ["edit_file", "git", "glob", "grep", "read_file", "shell", "web_fetch", "write_file"].sort(),
    );
    expect(reg.get("read_file")?.permissionLevel).toBe("safe");
    expect(reg.get("write_file")?.permissionLevel).toBe("write");
    expect(reg.get("shell")?.permissionLevel).toBe("exec");
    expect(reg.get("git")?.permissionLevel).toBe("safe");   // …read-only by construction
  });

  it("schemas() produces a name + JSON Schema for each tool", () => {
    const reg = createDefaultRegistry();
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(8);
    for (const s of schemas) {
      expect(typeof s.name).toBe("string");
      expect(s.parameters).toMatchObject({ type: "object" });
    }
  });
});
