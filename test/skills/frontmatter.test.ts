import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("frontmatter'dan name/description + body çıkarır", () => {
    const raw = "---\nname: tdd\ndescription: TDD akışı\n---\ngövde metni\nsatır2";
    expect(parseFrontmatter(raw)).toEqual({ name: "tdd", description: "TDD akışı", body: "gövde metni\nsatır2" });
  });

  it("tırnaklı değerleri kırpar", () => {
    const raw = '---\nname: "x y"\ndescription: \'z\'\n---\nb';
    expect(parseFrontmatter(raw)).toEqual({ name: "x y", description: "z", body: "b" });
  });

  it("frontmatter yoksa body=raw, alanlar undefined", () => {
    expect(parseFrontmatter("sadece metin")).toEqual({ body: "sadece metin" });
  });

  it("eksik alan undefined döner", () => {
    expect(parseFrontmatter("---\nname: x\n---\nb")).toEqual({ name: "x", description: undefined, body: "b" });
  });
});
