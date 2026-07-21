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

  it("Markdown kod-bloğunu dil-etiketi + satır-numarası ile render eder", () => {
    const f = render(<Markdown text={"```csharp\nvar x = 1;\nreturn x;\n```"} />).lastFrame() ?? "";
    expect(f).toContain("csharp");      // dil algılandı
    expect(f).toContain("1 │");         // satır numarası + ayraç
    expect(f).toContain("2 │");
    expect(f).toContain("return");      // kod içeriği (tek-token; renklendirme aralara ANSI koyar)
    expect(f).not.toContain("```");     // fence gizli
  });
});
