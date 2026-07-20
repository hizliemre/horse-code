import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), content, "utf8");
}

describe("SkillRegistry.loadFromDir", () => {
  it("SKILL.md'li dizinleri yükler", async () => {
    await writeSkill("tdd", "---\nname: tdd\ndescription: TDD\n---\ntdd gövde");
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD", content: "tdd gövde" });
  });

  it("SKILL.md'siz dizini atlar", async () => {
    await mkdir(join(dir, "boş"), { recursive: true });
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.list()).toEqual([]);
  });

  it("frontmatter eksikse hata verir", async () => {
    await writeSkill("bad", "frontmatter yok, sadece metin");
    const r = new SkillRegistry();
    await expect(r.loadFromDir(dir)).rejects.toThrow(/frontmatter eksik/);
  });

  it("var olmayan dizinde sessizce döner", async () => {
    const r = new SkillRegistry();
    await expect(r.loadFromDir(join(dir, "yok"))).resolves.toBeUndefined();
    expect(r.list()).toEqual([]);
  });
});
