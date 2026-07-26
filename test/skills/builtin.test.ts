import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinSkills } from "../../src/skills/builtin.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { DEFAULT_ROLE_SKILLS } from "../../src/prompts.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const skill = async (root: string, name: string, description: string, body: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}`, "utf8");
};

describe("built-in skills", () => {
  it("registers what it finds, content and all", async () => {
    await skill(dir, "brainstorming", "decide the approach first", "# Method\nExplore, then ask.");
    const reg = new SkillRegistry();
    expect(await registerBuiltinSkills(reg, [dir])).toBe(1);
    expect(reg.get("brainstorming")?.description).toBe("decide the approach first");
    expect(reg.get("brainstorming")?.content).toContain("Explore, then ask.");
  });

  // A project must be able to replace a shipped skill. Built-ins load FIRST precisely so the project's own
  // registration lands on top of them.
  it("a project skill of the same name overrides the built-in", async () => {
    await skill(dir, "brainstorming", "shipped", "shipped body");
    const project = await mkdtemp(join(tmpdir(), "hc-proj-"));
    try {
      await skill(project, "brainstorming", "mine", "my body");
      const reg = new SkillRegistry();
      await registerBuiltinSkills(reg, [dir]);
      await reg.loadFromDir(project);
      expect(reg.get("brainstorming")?.content).toContain("my body");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  // Skills are additive guidance, not machinery: a checkout without them must still start.
  it("no skills directory is not an error", async () => {
    const reg = new SkillRegistry();
    expect(await registerBuiltinSkills(reg, [join(dir, "nope")])).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it("a directory with no skill folders is skipped, not adopted", async () => {
    await writeFile(join(dir, "loose.md"), "not a skill", "utf8");
    expect(await registerBuiltinSkills(new SkillRegistry(), [dir])).toBe(0);
  });

  it("a malformed built-in is skipped rather than crashing startup", async () => {
    await mkdir(join(dir, "broken"), { recursive: true });
    await writeFile(join(dir, "broken", "SKILL.md"), "no frontmatter here", "utf8");
    await skill(dir, "good", "fine", "body");
    const reg = new SkillRegistry();
    expect(await registerBuiltinSkills(reg, [dir])).toBe(1);
    expect(reg.get("good")).toBeDefined();
    expect(reg.get("broken")).toBeUndefined();
  });

  it("tries each candidate location in turn", async () => {
    await skill(dir, "found", "here", "body");
    expect(await registerBuiltinSkills(new SkillRegistry(), [join(dir, "missing"), dir])).toBe(1);
  });
});

describe("the shipped brainstorming skill", () => {
  it("is discovered from the real repo layout", async () => {
    const reg = new SkillRegistry();
    await registerBuiltinSkills(reg);
    const s = reg.get("brainstorming");
    expect(s).toBeDefined();
    // Verbatim from the superpowers plugin — these are its own words, not a paraphrase.
    expect(s!.content).toContain("Brainstorming Ideas Into Designs");
    expect(s!.content).toContain("one at a time");
    expect(s!.content).toContain("Propose 2-3 approaches");
  });

  it("is attached to the brainstormer role by default", () => {
    expect(DEFAULT_ROLE_SKILLS.brainstormer).toEqual(["brainstorming"]);
  });
});
