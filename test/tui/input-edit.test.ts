import { describe, it, expect } from "vitest";
import { wordLeft, wordRight, lineStart, lineEnd } from "../../src/tui/input-edit.js";

describe("readline word/line motion", () => {
  it("wordLeft jumps to the start of the word before the cursor (skipping spaces)", () => {
    expect(wordLeft("foo bar baz", 11)).toBe(8); // |baz → start of baz
    expect(wordLeft("foo bar baz", 8)).toBe(4); // at 'baz' start → back to 'bar'
    expect(wordLeft("foo   bar", 6)).toBe(0); // skip the run of spaces, then 'foo'
    expect(wordLeft("foo", 0)).toBe(0); // already at start
  });

  it("wordRight jumps to the end of the word after the cursor (skipping spaces)", () => {
    expect(wordRight("foo bar baz", 0)).toBe(3); // foo|
    expect(wordRight("foo bar baz", 3)).toBe(7); // skip space → bar|
    expect(wordRight("foo   bar", 3)).toBe(9); // skip spaces → bar|
    expect(wordRight("foo", 3)).toBe(3); // already at end
  });

  it("lineStart / lineEnd bound the current line in multi-line input", () => {
    const v = "alpha\nbeta\ngamma";
    // cursor inside "beta" (index 7)
    expect(lineStart(v, 7)).toBe(6); // char after the first \n
    expect(lineEnd(v, 7)).toBe(10); // index of the \n after "beta"
    // first line
    expect(lineStart(v, 3)).toBe(0);
    expect(lineEnd(v, 3)).toBe(5);
    // last line (no trailing newline)
    expect(lineEnd(v, 13)).toBe(v.length);
  });
});
