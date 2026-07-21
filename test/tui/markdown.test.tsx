import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { parseInline, Markdown } from "../../src/tui/markdown.js";

describe("markdown", () => {
  it("parseInline **kalın** / `kod` / _italik_ ayrıştırır", () => {
    const segs = parseInline("normal **kalın** ve `kod` bitti");
    expect(segs.find((s) => s.bold)?.text).toBe("kalın");
    expect(segs.find((s) => s.code)?.text).toBe("kod");
    expect(segs.map((s) => s.text).join("")).toBe("normal kalın ve kod bitti");
  });

  it("Markdown kalın metni ** işaretleri olmadan render eder", () => {
    const f = render(<Markdown text="Ben **Gemini** modeliyim" />).lastFrame() ?? "";
    expect(f).toContain("Gemini");
    expect(f).not.toContain("**");
  });

  it("Markdown başlık ve liste render eder (işaretsiz)", () => {
    const f = render(<Markdown text={"# Başlık\n- madde bir"} />).lastFrame() ?? "";
    expect(f).toContain("Başlık");
    expect(f).not.toContain("# ");
    expect(f).toContain("madde bir");
    expect(f).toContain("•");
  });
});
