import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { parseInline, Markdown } from "../../src/tui/markdown.js";

describe("markdown", () => {
  it("parseInline parses **bold** / `code` / _italic_", () => {
    const segs = parseInline("normal **bold** and `code` done");
    expect(segs.find((s) => s.bold)?.text).toBe("bold");
    expect(segs.find((s) => s.code)?.text).toBe("code");
    expect(segs.map((s) => s.text).join("")).toBe("normal bold and code done");
  });

  it("Markdown renders bold text without ** markers", () => {
    const f = render(<Markdown text="I am **Gemini** model" />).lastFrame() ?? "";
    expect(f).toContain("Gemini");
    expect(f).not.toContain("**");
  });

  it("Markdown renders a heading and a list (unmarked)", () => {
    const f = render(<Markdown text={"# Heading\n- item one"} />).lastFrame() ?? "";
    expect(f).toContain("Heading");
    expect(f).not.toContain("# ");
    expect(f).toContain("item one");
    expect(f).toContain("•");
  });

  it("Markdown renders a code block with a language label + line numbers", () => {
    const f = render(<Markdown text={"```csharp\nvar x = 1;\nreturn x;\n```"} />).lastFrame() ?? "";
    expect(f).toContain("csharp");      // language detected
    expect(f).toContain("1 │");         // line number + separator
    expect(f).toContain("2 │");
    expect(f).toContain("return");      // code content (single token; coloring inserts ANSI in between)
    expect(f).not.toContain("```");     // fence hidden
  });
});
