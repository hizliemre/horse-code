import { describe, it, expect } from "vitest";
import { shouldCollapsePaste, pasteToken, expandPasteTokens, PASTE_COLLAPSE_CHARS } from "../../src/tui/paste.js";

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

describe("a placeholder must never leave the composer", () => {
  /**
   * Reported from a real session: pasted text showed as its placeholder and, on Enter, the PLACEHOLDER was
   * submitted. The expansion existed — it just sat at the bottom of the submit handler, past every early
   * return, so it covered a plain prompt and nothing else. Answering a question sent the literal token as
   * the answer; `/remember <paste>` stored the token as the memory.
   */
  it("expands a single-line paste that was collapsed only for its length", () => {
    const text = "x".repeat(PASTE_COLLAPSE_CHARS + 1);
    expect(shouldCollapsePaste(text)).toBe(true);
    const token = pasteToken(1, text);
    expect(token).toContain("1 line");                        // one line, and still collapsed
    expect(expandPasteTokens(token, new Map([[1, text]]))).toBe(text);
  });

  it("expands a placeholder embedded in a longer line, wherever it sits", () => {
    const map = new Map([[1, "the real text"], [2, "second"]]);
    expect(expandPasteTokens("before ⟨paste #1: 1 line⟩ after ⟨paste #2: 1 line⟩", map))
      .toBe("before the real text after second");
  });

  it("leaves an unknown id alone rather than deleting what the user typed", () => {
    expect(expandPasteTokens("⟨paste #9: 3 lines⟩", new Map())).toBe("⟨paste #9: 3 lines⟩");
  });
});
