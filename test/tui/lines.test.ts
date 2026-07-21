import { describe, it, expect } from "vitest";
import { wrapSegs, flattenMarkdown, flattenMessage, flattenSplash } from "../../src/tui/lines.js";

const txt = (lines: { text: string }[][]): string[] => lines.map((l) => l.map((s) => s.text).join(""));

describe("lines flatten", () => {
  it("wrapSegs wraps word-by-word (not char), leaves no leading space on a line", () => {
    const out = wrapSegs([{ text: "foo bar baz qux" }], 8);
    const rendered = txt(out);
    // every line <= 8 and words aren't split
    for (const line of rendered) expect(line.length).toBeLessThanOrEqual(8);
    expect(rendered.join(" ").replace(/\s+/g, " ").trim()).toBe("foo bar baz qux");
    expect(rendered.every((l) => !l.startsWith(" "))).toBe(true);
  });

  it("flattenMessage user: bullet on the first line, continuation lines indented (hanging indent)", () => {
    const out = flattenMessage("user", "aaaa bbbb cccc dddd eeee", 12);
    expect(out[0][0].text).toBe("› ");
    expect(out[0][0].color).toBe("gray");
    if (out.length > 1) expect(out[1][0].text).toBe("  ");
  });

  it("flattenMessage assistant: ● green bullet + markdown bold unmarked", () => {
    const out = flattenMessage("assistant", "I am **Gemini** model", 40);
    expect(out[0][0].text).toBe("● ");
    expect(out[0][0].color).toBe("green");
    const joined = txt(out).join("");
    expect(joined).toContain("Gemini");
    expect(joined).not.toContain("**");
  });

  it("flattenMarkdown produces a code block with a language label + line numbers", () => {
    const out = flattenMarkdown("```csharp\nvar x = 1;\nreturn x;\n```", 40);
    const joined = txt(out).join("\n");
    expect(joined).toContain("csharp");
    expect(joined).toContain("1 │");
    expect(joined).toContain("2 │");
    expect(joined).not.toContain("```");
  });

  it("flattenMarkdown produces a heading and a list (unmarked)", () => {
    const out = flattenMarkdown("# Heading\n- item one", 40);
    const joined = txt(out).join("\n");
    expect(joined).toContain("Heading");
    expect(joined).not.toContain("# ");
    expect(joined).toContain("item one");
    expect(joined).toContain("•");
  });

  it("flattenSplash produces lines based on size (not empty)", () => {
    const out = flattenSplash(80, 30);
    expect(out.length).toBeGreaterThan(0);
  });
});
