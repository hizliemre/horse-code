import { describe, it, expect } from "vitest";
import { applySkills, buildSkillTool } from "../../src/skills/apply.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

function reg(): SkillRegistry {
  const r = new SkillRegistry();
  r.register({ name: "tdd", description: "TDD akışı", content: "önce test yaz" });
  r.register({ name: "cs", description: "kod standartları", content: "temiz kod" });
  return r;
}

describe("applySkills", () => {
  it("zorunlu içerik + keşfedilebilir listing ekler", () => {
    const out = applySkills("BASE", ["tdd"], reg());
    expect(out).toContain("BASE");
    expect(out).toContain("# Zorunlu Skill'ler");
    expect(out).toContain("## tdd");
    expect(out).toContain("önce test yaz");
    expect(out).toContain("# Keşfedilebilir Skill'ler");
    expect(out).toContain("- tdd: TDD akışı");
    expect(out).toContain("- cs: kod standartları");
  });

  it("tanımsız zorunlu skill → hata", () => {
    expect(() => applySkills("BASE", ["yok"], reg())).toThrow(/tanımsız skill/);
  });

  it("boş registry + boş mandatory → basePrompt değişmez", () => {
    expect(applySkills("BASE", [], new SkillRegistry())).toBe("BASE");
  });
});

describe("buildSkillTool", () => {
  it("bilinen skill'in içeriğini döner", async () => {
    const t = buildSkillTool(reg());
    expect(t.name).toBe("skill");
    expect(t.permissionLevel).toBe("safe");
    const res = await t.run({ name: "tdd" }, ctx());
    expect(res).toEqual({ content: "önce test yaz", isError: false });
  });

  it("bilinmeyen skill → isError", async () => {
    const res = await buildSkillTool(reg()).run({ name: "yok" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("bulunamadı");
  });
});
