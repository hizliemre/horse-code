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

/**
 * Cmd+V cannot be the trigger, however much a Mac user expects it to be.
 *
 * The terminal owns that chord: it reads the clipboard itself and writes the result to stdin, and for an
 * IMAGE there is no text to write — so the application is never told anything happened. Nothing can be
 * hooked, because nothing arrives.
 *
 * Ctrl+V does arrive: `\x16`, straight through, no terminal configuration. Alt+V works too but needs Option
 * bound to Meta, which is not the default anywhere.
 */
describe("which key can actually trigger an image paste", () => {
  it("recognises Ctrl+V and Alt+V, and nothing that would eat a real keystroke", async () => {
    const { isImagePaste } = await import("../../src/tui/keys.js");
    expect(isImagePaste("\x16")).toBe(true);      // Ctrl+V — the raw byte
    expect(isImagePaste("\x1bv")).toBe(true);     // Alt+V — needs Option-as-Meta
    expect(isImagePaste("\x1bV")).toBe(true);
    expect(isImagePaste("v")).toBe(false);
    expect(isImagePaste("\x1b")).toBe(false);
    expect(isImagePaste("")).toBe(false);
  });

  /**
   * The form the key ACTUALLY arrives in, which is not the raw byte.
   *
   * This TUI turns the kitty keyboard protocol on (`\x1b[>1u`, app.tsx), and under it a modified key comes as
   * a CSI-u sequence rather than a control byte — the codebase already knows this for Ctrl+C, which it checks
   * for as `\x1b[99;5u` beside `\x03`. Ctrl+V had only the raw byte, so it was parsed as an unknown
   * functional key and dropped in silence.
   *
   * Measured in the user's own terminal: outside horse-code Ctrl+V gives `0x16`, which is exactly why the
   * key test looked fine while the key did nothing.
   */
  it("recognises the CSI-u form the kitty protocol actually sends", async () => {
    const { isImagePaste } = await import("../../src/tui/keys.js");
    expect(isImagePaste("\x1b[118;5u")).toBe(true);  // ctrl+v   (118 = "v", modifier 5 = ctrl)
    expect(isImagePaste("\x1b[118;3u")).toBe(true);  // alt+v
    expect(isImagePaste("\x1b[118;7u")).toBe(true);  // ctrl+alt+v
    // …and never the unmodified key, which is a person typing the letter v.
    expect(isImagePaste("\x1b[118u")).toBe(false);
    expect(isImagePaste("\x1b[118;1u")).toBe(false);
    expect(isImagePaste("\x1b[118;2u")).toBe(false); // shift+v is a capital V
    // …nor another letter with the same modifier.
    expect(isImagePaste("\x1b[99;5u")).toBe(false);  // that is Ctrl+C
  });
});

/**
 * A placeholder is one thing, so backspace deletes one thing.
 *
 * `[Pasted Image #1]` is eighteen characters and erasing it took eighteen presses, each one leaving a
 * half-destroyed marker on screen — `[Pasted Image #`, `[Pasted Imag`. Worse, the intermediate states are no
 * longer a token, so anything reading the composer sees debris.
 *
 * The text placeholder has the same shape and the same problem.
 */
describe("a placeholder is deleted whole", () => {
  it("finds the placeholder that ends exactly at the cursor", async () => {
    const { tokenBefore } = await import("../../src/tui/paste.js");
    const v = "look at [Pasted Image #2] ok";
    expect(tokenBefore(v, 25)).toEqual({ start: 8, end: 25, kind: "image", id: 2 });
    // …and nothing when the cursor is anywhere else in it.
    expect(tokenBefore(v, 24)).toBeUndefined();
    expect(tokenBefore(v, 28)).toBeUndefined();
  });

  it("finds a collapsed text paste too", async () => {
    const { tokenBefore, pasteToken } = await import("../../src/tui/paste.js");
    const tok = pasteToken(3, "a\nb\nc\nd");
    const v = `before ${tok}`;
    expect(tokenBefore(v, v.length)).toEqual({ start: 7, end: v.length, kind: "text", id: 3 });
  });

  it("says nothing about ordinary text", async () => {
    const { tokenBefore } = await import("../../src/tui/paste.js");
    expect(tokenBefore("just words", 10)).toBeUndefined();
    expect(tokenBefore("", 0)).toBeUndefined();
    expect(tokenBefore("[Pasted Image #x]", 17)).toBeUndefined();  // not a number → not a placeholder
  });

  /** Two of them in a row must not be taken as one. */
  it("takes only the last one when several sit together", async () => {
    const { tokenBefore } = await import("../../src/tui/paste.js");
    const v = "[Pasted Image #1][Pasted Image #2]";
    expect(tokenBefore(v, v.length)).toEqual({ start: 17, end: 34, kind: "image", id: 2 });
  });
});
