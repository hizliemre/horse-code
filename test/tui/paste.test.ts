import { describe, it, expect } from "vitest";
import { shouldCollapsePaste, pasteToken, expandPasteTokens } from "../../src/tui/paste.js";

describe("shouldCollapsePaste", () => {
  it("collapses long or multi-line pastes, leaves small ones inline", () => {
    expect(shouldCollapsePaste("hello")).toBe(false);
    expect(shouldCollapsePaste("a\nb")).toBe(false); // 1 newline
    expect(shouldCollapsePaste("a\nb\nc\nd")).toBe(true); // 3 newlines
    expect(shouldCollapsePaste("x".repeat(201))).toBe(true); // long
  });
});

describe("pasteToken / expandPasteTokens", () => {
  it("round-trips: a placeholder expands back to the full text", () => {
    const full = "line1\nline2\nline3\nline4";
    const tok = pasteToken(1, full);
    expect(tok).toBe("⟨paste #1: 4 lines⟩");
    const map = new Map([[1, full]]);
    expect(expandPasteTokens(`see this ${tok} ok`, map)).toBe(`see this ${full} ok`);
  });

  it("expands multiple placeholders and leaves unknown ids untouched", () => {
    const map = new Map([[1, "AAA"], [2, "BBB"]]);
    expect(expandPasteTokens("⟨paste #1: 1 line⟩ and ⟨paste #2: 1 line⟩", map)).toBe("AAA and BBB");
    expect(expandPasteTokens("⟨paste #9: 1 line⟩", map)).toBe("⟨paste #9: 1 line⟩"); // unknown → left as-is
  });

  it("singular vs plural line label", () => {
    expect(pasteToken(3, "just one")).toBe("⟨paste #3: 1 line⟩");
  });
});
