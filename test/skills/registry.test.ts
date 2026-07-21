import { describe, it, expect } from "vitest";
import { SkillRegistry } from "../../src/skills/registry.js";

const skill = (name: string, description = "d", content = "c") => ({ name, description, content });

describe("SkillRegistry core", () => {
  it("register + get", () => {
    const r = new SkillRegistry();
    r.register(skill("tdd", "TDD workflow", "tdd content"));
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD workflow", content: "tdd content" });
    expect(r.get("missing")).toBeUndefined();
  });

  it("list preserves insertion order, returns {name,description}", () => {
    const r = new SkillRegistry();
    r.register(skill("a"));
    r.register(skill("b", "bb"));
    expect(r.list()).toEqual([
      { name: "a", description: "d" },
      { name: "b", description: "bb" },
    ]);
  });

  it("same-named skill is overwritten (last wins)", () => {
    const r = new SkillRegistry();
    r.register(skill("x", "old"));
    r.register(skill("x", "new"));
    expect(r.get("x")!.description).toBe("new");
    expect(r.list()).toHaveLength(1);
  });
});
