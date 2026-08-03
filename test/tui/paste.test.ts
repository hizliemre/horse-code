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

/**
 * A pasted image needs to be VISIBLE in the composer.
 *
 * Reported from a live run: "resim yapıştıramadım, ya da yapıştırdığıma dair bir ibare göremiyorum —
 * [Pasted Image #1] gibi bir ibare görmek istiyorum". A count under the input is not the same thing: it does
 * not say WHERE in the sentence the picture belongs, and it disappears from the transcript afterwards.
 *
 * The token carries the image the same way the text one carries a paste — the composer shows a placeholder,
 * and submitting expands it to something downstream can act on: the file the image was written to.
 */
describe("pasted images get a visible placeholder too", () => {
  it("reads as a person would expect, and is expanded to the file on submit", async () => {
    const { imageToken, expandImageTokens } = await import("../../src/tui/paste.js");
    expect(imageToken(1)).toBe("[Pasted Image #1]");
    const map = new Map([[1, "/tmp/hc-paste-1.png"], [2, "/tmp/hc-paste-2.png"]]);
    expect(expandImageTokens("before [Pasted Image #1] after", map)).toBe("before /tmp/hc-paste-1.png after");
    expect(expandImageTokens("[Pasted Image #2] and [Pasted Image #1]", map))
      .toBe("/tmp/hc-paste-2.png and /tmp/hc-paste-1.png");
  });

  it("leaves a placeholder nobody staged alone, rather than deleting the words", async () => {
    const { expandImageTokens } = await import("../../src/tui/paste.js");
    expect(expandImageTokens("[Pasted Image #9] here", new Map())).toBe("[Pasted Image #9] here");
  });

  /** The two kinds of paste share a composer and must not eat each other's placeholders. */
  it("does not collide with the text paste placeholder", async () => {
    const { expandImageTokens, expandPasteTokens } = await import("../../src/tui/paste.js");
    const text = "⟨paste #1: 4 lines⟩ and [Pasted Image #1]";
    expect(expandImageTokens(text, new Map([[1, "/tmp/a.png"]]))).toBe("⟨paste #1: 4 lines⟩ and /tmp/a.png");
    expect(expandPasteTokens(text, new Map([[1, "hello"]]))).toBe("hello and [Pasted Image #1]");
  });
});
