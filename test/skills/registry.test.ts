import { describe, it, expect } from "vitest";
import { SkillRegistry } from "../../src/skills/registry.js";

const skill = (name: string, description = "d", content = "c") => ({ name, description, content });

describe("SkillRegistry çekirdek", () => {
  it("register + get", () => {
    const r = new SkillRegistry();
    r.register(skill("tdd", "TDD akışı", "tdd içerik"));
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD akışı", content: "tdd içerik" });
    expect(r.get("yok")).toBeUndefined();
  });

  it("list ekleme sırasını korur, {name,description} verir", () => {
    const r = new SkillRegistry();
    r.register(skill("a"));
    r.register(skill("b", "bb"));
    expect(r.list()).toEqual([
      { name: "a", description: "d" },
      { name: "b", description: "bb" },
    ]);
  });

  it("aynı adlı skill ezilir (son kazanır)", () => {
    const r = new SkillRegistry();
    r.register(skill("x", "eski"));
    r.register(skill("x", "yeni"));
    expect(r.get("x")!.description).toBe("yeni");
    expect(r.list()).toHaveLength(1);
  });
});
