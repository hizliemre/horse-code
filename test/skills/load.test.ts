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
  it("loads directories containing SKILL.md", async () => {
    await writeSkill("tdd", "---\nname: tdd\ndescription: TDD\n---\ntdd body");
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.get("tdd")).toEqual({ name: "tdd", description: "TDD", content: "tdd body" });
  });

  it("skips a directory without SKILL.md", async () => {
    await mkdir(join(dir, "empty"), { recursive: true });
    const r = new SkillRegistry();
    await r.loadFromDir(dir);
    expect(r.list()).toEqual([]);
  });

  it("throws an error when frontmatter is missing", async () => {
    await writeSkill("bad", "no frontmatter, just text");
    const r = new SkillRegistry();
    await expect(r.loadFromDir(dir)).rejects.toThrow(/missing frontmatter/);
  });

  it("returns silently for a non-existent directory", async () => {
    const r = new SkillRegistry();
    await expect(r.loadFromDir(join(dir, "missing"))).resolves.toBeUndefined();
    expect(r.list()).toEqual([]);
  });
});
