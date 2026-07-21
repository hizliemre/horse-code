import { describe, it, expect } from "vitest";
import { applySkills, buildSkillTool } from "../../src/skills/apply.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

function reg(): SkillRegistry {
  const r = new SkillRegistry();
  r.register({ name: "tdd", description: "TDD workflow", content: "write tests first" });
  r.register({ name: "cs", description: "code standards", content: "clean code" });
  return r;
}

describe("applySkills", () => {
  it("adds mandatory content + a discoverable listing", () => {
    const out = applySkills("BASE", ["tdd"], reg());
    expect(out).toContain("BASE");
    expect(out).toContain("# Mandatory Skills");
    expect(out).toContain("## tdd");
    expect(out).toContain("write tests first");
    expect(out).toContain("# Discoverable Skills");
    expect(out).not.toContain("- tdd: TDD workflow");
    expect(out).toContain("- cs: code standards");
  });

  it("undefined mandatory skill → error", () => {
    expect(() => applySkills("BASE", ["missing"], reg())).toThrow(/undefined skill/);
  });

  it("empty registry + empty mandatory → basePrompt unchanged", () => {
    expect(applySkills("BASE", [], new SkillRegistry())).toBe("BASE");
  });
});

describe("buildSkillTool", () => {
  it("returns a known skill's content", async () => {
    const t = buildSkillTool(reg());
    expect(t.name).toBe("skill");
    expect(t.permissionLevel).toBe("safe");
    const res = await t.run({ name: "tdd" }, ctx());
    expect(res).toEqual({ content: "write tests first", isError: false });
  });

  it("unknown skill → isError", async () => {
    const res = await buildSkillTool(reg()).run({ name: "missing" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });
});
