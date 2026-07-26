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

// The point of shipping these is that the WRITING roles get the discipline inlined, instead of a review lens
// rejecting the result afterwards. Rejecting costs a whole extra round; getting it right the first time does not.
describe("the shipped skills reach the roles that need them", () => {
  const reg = async (): Promise<SkillRegistry> => {
    const r = new SkillRegistry();
    await registerBuiltinSkills(r);
    return r;
  };

  it("ships the expected set", async () => {
    const names = (await reg()).list().map((s) => s.name).sort();
    expect(names).toEqual([
      "brainstorming", "frontend-design", "systematic-debugging", "test-driven-development", "writing-plans",
    ]);
  });

  it("the UI roles get design direction, for the same reason the coders get TDD", () => {
    expect(DEFAULT_ROLE_SKILLS.designer).toEqual(["frontend-design"]);
    expect(DEFAULT_ROLE_SKILLS["senior-designer"]).toEqual(["frontend-design"]);
  });

  it("the code-writing roles get the test discipline; the task list gets the planning discipline", () => {
    expect(DEFAULT_ROLE_SKILLS.coder).toEqual(["test-driven-development"]);
    expect(DEFAULT_ROLE_SKILLS["senior-coder"]).toEqual(["test-driven-development"]);
    expect(DEFAULT_ROLE_SKILLS["project-manager"]).toEqual(["writing-plans"]);
  });

  // Only needed when something is stuck — inlining it into every prompt would be pure waste.
  it("systematic-debugging is DISCOVERABLE, not attached to any role", async () => {
    expect((await reg()).get("systematic-debugging")).toBeDefined();
    for (const skills of Object.values(DEFAULT_ROLE_SKILLS)) {
      expect(skills).not.toContain("systematic-debugging");
    }
  });

  // spec-kit's own plan template already governs plan.md; a second template there would fight it. The skill's
  // contribution is what makes an individual TASK executable.
  it("writing-plans is bound to the task list, not to the planner", () => {
    expect(DEFAULT_ROLE_SKILLS.planner).toBeUndefined();
  });

  it("each shipped skill carries the frontmatter the loader requires", async () => {
    for (const s of (await reg()).list()) {
      expect(s.name).toBeTruthy();
      expect(s.description.length).toBeGreaterThan(20);
    }
  });
});
