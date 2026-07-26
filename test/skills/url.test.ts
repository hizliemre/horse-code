import { describe, it, expect } from "vitest";
import { parseSkillUrl } from "../../src/skills/external.js";

describe("parseSkillUrl — accepts what a user actually pastes", () => {
  it("takes a repo root, naming the skill after the repo", () => {
    expect(parseSkillUrl("https://github.com/pbakaus/impeccable")).toEqual({
      name: "impeccable", repo: "pbakaus/impeccable",
    });
  });

  // The name must come from the DIRECTORY holding SKILL.md — one repo can hold many skills, and the registry
  // is keyed by name. Naming this one "skills" would collide with every other skill from the same repo.
  it("takes a deep tree link, naming the skill after its directory", () => {
    expect(parseSkillUrl("https://github.com/anthropics/skills/tree/main/skills/frontend-design")).toEqual({
      name: "frontend-design", repo: "anthropics/skills", path: "skills/frontend-design",
    });
  });

  it("a link straight to SKILL.md is the same as a link to its directory", () => {
    expect(parseSkillUrl("https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md")).toEqual({
      name: "frontend-design", repo: "anthropics/skills", path: "skills/frontend-design",
    });
  });

  // A default branch in the URL is where the user happened to be browsing, not a pin they asked for. Keeping
  // it would freeze the skill at that branch name and make "update" a no-op against a moved default.
  it.each(["main", "master", "HEAD"])("does not pin to the default branch %s", (ref) => {
    expect(parseSkillUrl(`https://github.com/o/r/tree/${ref}/a/b`)?.ref).toBeUndefined();
  });

  it("keeps a real pin", () => {
    expect(parseSkillUrl("https://github.com/o/r/tree/v2.1.0/a/b")?.ref).toBe("v2.1.0");
  });

  it.each([
    "github.com/o/r",
    "http://github.com/o/r",
    "https://www.github.com/o/r",
    "https://github.com/o/r/",
    "  https://github.com/o/r  ",
  ])("tolerates the shape %o", (url) => {
    expect(parseSkillUrl(url)).toEqual({ name: "r", repo: "o/r" });
  });

  it("strips a .git suffix rather than baking it into the name", () => {
    expect(parseSkillUrl("https://github.com/o/r.git")).toEqual({ name: "r", repo: "o/r" });
  });

  it.each([
    "https://gitlab.com/o/r",
    "https://example.com/github.com/o/r",
    "not a url",
    "",
    "https://github.com/o",
  ])("refuses %o rather than guessing", (url) => {
    expect(parseSkillUrl(url)).toBeUndefined();
  });
});
