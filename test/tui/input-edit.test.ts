import { describe, it, expect } from "vitest";
import { applyKey, wordLeft, wordRight, lineStart, lineEnd, EDIT_KEYS } from "../../src/tui/input-edit.js";

describe("word and line boundaries", () => {
  const V = "alpha beta  gamma";
  it("walks whole words backwards, skipping the spaces first", () => {
    expect(wordLeft(V, V.length)).toBe(12);
    expect(wordLeft(V, 12)).toBe(6);
  });
  it("walks whole words forwards", () => {
    expect(wordRight(V, 0)).toBe(5);
    expect(wordRight(V, 5)).toBe(10);
  });
  it("bounds a line by its newlines, not by the buffer", () => {
    const M = "one\ntwo three\nfour";
    expect(lineStart(M, 6)).toBe(4);
    expect(lineEnd(M, 6)).toBe(13);
  });
});

/**
 * The bindings were a chain of `if` tests in the render file, and the set was partial: Ctrl+arrow word motion
 * was bound but Alt+arrow — the macOS default, and what most people actually press — was not, nor
 * Alt+Backspace, nor deleting a word forwards, and Home/End jumped to the ends of the whole buffer rather
 * than of the line.
 */
describe("applyKey", () => {
  const V = "alpha beta gamma";

  it("moves a word left on EVERY form a terminal sends for it", () => {
    for (const k of ["\x1b[1;5D", "\x1b[1;3D", "\x1b[1;9D", "\x1b\x1b[D", "\x1b[5D", "\x1bb"]) {
      expect(applyKey(k, V, V.length)?.cursor, k).toBe(11);
    }
  });

  it("moves a word right on every form too", () => {
    for (const k of ["\x1b[1;5C", "\x1b[1;3C", "\x1b[1;9C", "\x1b\x1b[C", "\x1b[5C", "\x1bf"]) {
      expect(applyKey(k, V, 0)?.cursor, k).toBe(5);
    }
  });

  /** In a multi-line field Home/End belong to the LINE; the buffer's ends are the modified forms. */
  it("puts Home and End on the line, and Ctrl/Alt+Home-End on the buffer", () => {
    const M = "one\ntwo three\nfour";
    expect(applyKey("\x1b[H", M, 6)?.cursor).toBe(4);
    expect(applyKey("\x1b[F", M, 6)?.cursor).toBe(13);
    expect(applyKey("\x1b[1;5H", M, 6)?.cursor).toBe(0);
    expect(applyKey("\x1b[1;5F", M, 6)?.cursor).toBe(M.length);
    expect(applyKey("\x01", M, 6)?.cursor).toBe(4); // Ctrl+A still works
    expect(applyKey("\x05", M, 6)?.cursor).toBe(13);
  });

  it("deletes a word backwards with Ctrl+W AND Alt+Backspace", () => {
    for (const k of ["\x17", "\x1b\x7f", "\x1b\x08"]) {
      expect(applyKey(k, V, V.length), k).toEqual({ value: "alpha beta ", cursor: 11 });
    }
  });

  it("deletes a word forwards — which nothing could do before", () => {
    for (const k of ["\x1bd", "\x1b[3;5~", "\x1b[3;3~"]) {
      expect(applyKey(k, V, 0), k).toEqual({ value: " beta gamma", cursor: 0 });
    }
  });

  it("kills to the start and to the end of the LINE", () => {
    const M = "one\ntwo three\nfour";
    expect(applyKey("\x15", M, 8)).toEqual({ value: "one\nthree\nfour", cursor: 4 });
    expect(applyKey("\x0b", M, 8)).toEqual({ value: "one\ntwo \nfour", cursor: 8 }); // 8 is "three"'s t
  });

  it("never walks past either end", () => {
    expect(applyKey("\x1b[D", V, 0)?.cursor).toBe(0);
    expect(applyKey("\x1b[C", V, V.length)?.cursor).toBe(V.length);
    expect(applyKey("\x7f", V, 0)).toEqual({ value: V, cursor: 0 });
    expect(applyKey("\x1b[3~", V, V.length)).toEqual({ value: V, cursor: V.length });
  });

  it("leaves anything that is not an editing key to the caller", () => {
    expect(applyKey("a", V, 0)).toBeUndefined();
    expect(applyKey("\r", V, 0)).toBeUndefined();
    expect(applyKey("\x03", V, 0)).toBeUndefined(); // Ctrl+C is the two-step quit, not an edit
    expect(applyKey("\x1bv", V, 0)).toBeUndefined(); // Alt+V pastes an image
  });

  /** A key bound twice to different actions is a key whose behaviour depends on table order. */
  it("binds no sequence to two different actions", () => {
    expect(new Set(EDIT_KEYS).size).toBe(EDIT_KEYS.length);
  });
});
