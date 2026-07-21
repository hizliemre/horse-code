import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("extracts name/description + body from frontmatter", () => {
    const raw = "---\nname: tdd\ndescription: TDD workflow\n---\nbody text\nline2";
    expect(parseFrontmatter(raw)).toEqual({ name: "tdd", description: "TDD workflow", body: "body text\nline2" });
  });

  it("trims quoted values", () => {
    const raw = '---\nname: "x y"\ndescription: \'z\'\n---\nb';
    expect(parseFrontmatter(raw)).toEqual({ name: "x y", description: "z", body: "b" });
  });

  it("body=raw when there's no frontmatter, fields undefined", () => {
    expect(parseFrontmatter("just text")).toEqual({ body: "just text" });
  });

  it("returns undefined for a missing field", () => {
    expect(parseFrontmatter("---\nname: x\n---\nb")).toEqual({ name: "x", description: undefined, body: "b" });
  });
});
