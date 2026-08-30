import { describe, it, expect } from "vitest";
import { applySkills, buildSkillTool, noSuchSkill, MAX_SKILLS_LISTED } from "../../src/skills/apply.js";
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

/**
 * An empty `file` means "the skill", not "a document with no name".
 *
 * Measured on a live run: `skill(name: "angular-developer", file: "")` — four calls in one turn, four
 * different skills, every one of them present on disk. `resolve(dir, "")` is the directory itself, so the
 * read fell through to the document path, hit the folder, and came back "no such document: ". The agent was
 * told its skill did not exist while the file sat there, and went off to work without it.
 */
describe("a skill asked for with an empty file", () => {
  const withDir = async (): Promise<{ dir: string; tool: ReturnType<typeof buildSkillTool> }> => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "hc-skill-"));
    await writeFile(join(dir, "SKILL.md"), "the skill itself");
    await writeFile(join(dir, "critique.md"), "the critique");
    await mkdir(join(dir, "reference"));
    const r = new SkillRegistry();
    r.register({ name: "ng", description: "angular", content: "the skill itself", dir });
    return { dir, tool: buildSkillTool(r) };
  };

  it("reads the skill, the way omitting it does", async () => {
    const { tool } = await withDir();
    const res = await tool.run({ name: "ng", file: "" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("the skill itself");
  });

  it("treats blank space the same — it is not a file name either", async () => {
    const { tool } = await withDir();
    expect((await tool.run({ name: "ng", file: "   " }, ctx())).isError).toBeFalsy();
  });

  it("still fetches a real supporting document", async () => {
    const { tool } = await withDir();
    const res = await tool.run({ name: "ng", file: "critique.md" }, ctx());
    expect(res.content).toBe("the critique");
  });

  it("says what the skill DOES have when the document is not one of them", async () => {
    const { tool } = await withDir();
    const res = await tool.run({ name: "ng", file: "reference/nope.md" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no such document: reference/nope.md");
    expect(res.content).toContain("critique.md");   // …and what it could have asked for instead
    expect(res.content).toContain("reference/");
    expect(res.content).not.toContain("SKILL.md"); // the skill itself is not a supporting document
  });
});

/**
 * "no such skill" is only useful beside "these exist".
 *
 * Measured live: a plan lens called `skill(name: "review-plan")`, a name it had invented, and the entire
 * reply was `skill not found: review-plan`. That is the message `unknown tool: <name>` used to be before it
 * started naming the tools that do exist — and that one cost seven turns and a phase's whole output once.
 */
describe("a skill that does not exist", () => {
  const SKILLS = ["angular-developer", "apple-design", "pick-ui-library"];

  it("lists what this project has", async () => {
    const { noSuchSkill } = await import("../../src/skills/apply.js");
    const msg = noSuchSkill("review-plan", SKILLS);
    for (const s of SKILLS) expect(msg).toContain(s);
  });

  it("tells it not to guess another name", async () => {
    const { noSuchSkill } = await import("../../src/skills/apply.js");
    expect(noSuchSkill("review-plan", SKILLS)).toMatch(/do not guess/i);
  });

  /** A punctuation variant of a real name is the mistake models actually make — see resolveByShape. */
  it("resolves a name that differs only in punctuation", async () => {
    const { noSuchSkill } = await import("../../src/skills/apply.js");
    expect(noSuchSkill("angular_developer", SKILLS)).toContain("did you mean `angular-developer`");
    expect(noSuchSkill("Apple Design", SKILLS)).toContain("did you mean `apple-design`");
  });

  it("says so plainly when the project has no skills at all", async () => {
    const { noSuchSkill } = await import("../../src/skills/apply.js");
    const msg = noSuchSkill("anything", []);
    expect(msg).toMatch(/no skills installed/i);
    expect(msg).not.toMatch(/Available:/);
  });
});

/**
 * "There are ten-odd skills in a project, so they all fit" stopped being true.
 *
 * Measured live: a project with 87 installed skills answered a miss by listing all 87. The list was the
 * longest part of the message, it was paid on every miss, and it buried the one line that would have ended
 * the question — the agent had asked for `review` while `review-return` sat in that list.
 */
describe("a skill miss in a project with many skills", () => {
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `skill-${i}`);

  it("offers the near miss instead of the catalogue", () => {
    const text = noSuchSkill("review", ["review-return", "code-review-checklist", ...many(80)]);
    expect(text).toContain("`review-return`");
    expect(text).toContain("`code-review-checklist`");
    expect(text).not.toContain("skill-40");           // the other eighty are not the answer
    expect(text.length).toBeLessThan(300);
  });

  it("caps the list when nothing is close, and says how many were left out", () => {
    const text = noSuchSkill("nothing-like-this", many(87));
    expect(text).toContain(`and ${87 - MAX_SKILLS_LISTED} more`);
    expect(text.split(", ").length).toBeLessThan(MAX_SKILLS_LISTED + 6);
  });

  /** The behaviour that was already right, and must stay right: a punctuation variant is resolved outright. */
  it("still resolves a punctuation variant rather than offering it", () => {
    expect(noSuchSkill("test_driven_development", ["test-driven-development"]))
      .toContain("did you mean `test-driven-development`?");
  });

  it("still says so plainly when a project has no skills at all", () => {
    expect(noSuchSkill("anything", [])).toContain("no skills installed");
  });

  /** A short project keeps the old behaviour: every name fits, so every name is given. */
  it("names them all when they do all fit", () => {
    const text = noSuchSkill("zzz", ["alpha", "beta", "gamma"]);
    for (const s of ["alpha", "beta", "gamma"]) expect(text).toContain(s);
    expect(text).not.toContain("more");
  });
});
