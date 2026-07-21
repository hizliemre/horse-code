import { describe, it, expect } from "vitest";
import { wrapSegs, flattenMarkdown, flattenMessage, flattenSplash } from "../../src/tui/lines.js";

const txt = (lines: { text: string }[][]): string[] => lines.map((l) => l.map((s) => s.text).join(""));

describe("lines flatten", () => {
  it("wrapSegs kelime-bazında sarar (char değil), satır başında boşluk bırakmaz", () => {
    const out = wrapSegs([{ text: "foo bar baz qux" }], 8);
    const rendered = txt(out);
    // her satır <= 8 ve kelimeler bölünmemiş
    for (const line of rendered) expect(line.length).toBeLessThanOrEqual(8);
    expect(rendered.join(" ").replace(/\s+/g, " ").trim()).toBe("foo bar baz qux");
    expect(rendered.every((l) => !l.startsWith(" "))).toBe(true);
  });

  it("flattenMessage user: bullet ilk satırda, devam satırları girintili (hanging indent)", () => {
    const out = flattenMessage("user", "aaaa bbbb cccc dddd eeee", 12);
    expect(out[0][0].text).toBe("› ");
    expect(out[0][0].color).toBe("gray");
    if (out.length > 1) expect(out[1][0].text).toBe("  ");
  });

  it("flattenMessage assistant: ● yeşil bullet + markdown kalın işaretsiz", () => {
    const out = flattenMessage("assistant", "Ben **Gemini** modeliyim", 40);
    expect(out[0][0].text).toBe("● ");
    expect(out[0][0].color).toBe("green");
    const joined = txt(out).join("");
    expect(joined).toContain("Gemini");
    expect(joined).not.toContain("**");
  });

  it("flattenMarkdown kod-bloğunu dil-etiketi + satır-numarası ile üretir", () => {
    const out = flattenMarkdown("```csharp\nvar x = 1;\nreturn x;\n```", 40);
    const joined = txt(out).join("\n");
    expect(joined).toContain("csharp");
    expect(joined).toContain("1 │");
    expect(joined).toContain("2 │");
    expect(joined).not.toContain("```");
  });

  it("flattenMarkdown başlık ve liste üretir (işaretsiz)", () => {
    const out = flattenMarkdown("# Başlık\n- madde bir", 40);
    const joined = txt(out).join("\n");
    expect(joined).toContain("Başlık");
    expect(joined).not.toContain("# ");
    expect(joined).toContain("madde bir");
    expect(joined).toContain("•");
  });

  it("flattenSplash boyuta göre satır üretir (boş değil)", () => {
    const out = flattenSplash(80, 30);
    expect(out.length).toBeGreaterThan(0);
  });
});
