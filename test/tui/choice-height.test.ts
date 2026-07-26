import { describe, it, expect } from "vitest";
import { choiceHeight, wrapPlain, pendingBodyWidth } from "../../src/tui/components.js";
import { flattenMarkdown } from "../../src/tui/lines.js";

/**
 * The layout reserved fewer rows than the component painted, so Ink drew over the region above it: the
 * question the user was answering got overwritten, and option text collided mid-line with the option below.
 *
 * The formula said `optionCount + 3`, from a version that drew one row per option and had no notes line. It
 * then grew a description row per option, a notes row, and a preview panel — and none were added here.
 */
describe("choiceHeight matches what ChoiceInput draws", () => {
  const FIXED = 2 /* border */ + 1 /* notes */ + 1 /* hint */;

  it("counts one row per plain option", () => {
    expect(choiceHeight(["a", "b", "c"])).toBe(3 + FIXED);
  });

  // The row that was missing: a description is drawn under its label.
  it("counts the description row", () => {
    expect(choiceHeight([{ label: "a", description: "why a" }, { label: "b" }])).toBe(3 + FIXED);
  });

  it("counts a description on every option", () => {
    const opts = Array.from({ length: 4 }, (_, i) => ({ label: `o${i}`, description: "d" }));
    expect(choiceHeight(opts)).toBe(8 + FIXED);
  });

  it("accepts plain strings and rich options together", () => {
    expect(choiceHeight(["plain", { label: "rich", description: "d" }])).toBe(3 + FIXED);
  });

  describe("the preview panel", () => {
    const preview = { label: "a", preview: "line1\nline2\nline3" };

    /** Side by side, the row is as tall as whichever column is taller; the preview carries its own border. */
    it("is measured beside the list on a wide terminal", () => {
      expect(choiceHeight([preview, { label: "b" }], 120)).toBe(Math.max(2, 3 + 2) + FIXED);
    });

    /** Stacked, it is the list plus a margin plus the bordered panel. */
    it("is measured under the list on a narrow terminal", () => {
      expect(choiceHeight([preview, { label: "b" }], 60)).toBe(2 + (3 + 3) + FIXED);
    });

    // The preview belongs to the focused option, so the tallest one is what has to fit.
    it("reserves for the tallest preview, not the first", () => {
      const opts = [{ label: "a", preview: "one" }, { label: "b", preview: "1\n2\n3\n4\n5" }];
      expect(choiceHeight(opts, 120)).toBe(Math.max(2, 5 + 2) + FIXED);
    });

    it("reserves nothing when no option has one", () => {
      expect(choiceHeight([{ label: "a" }, { label: "b" }], 120)).toBe(2 + FIXED);
    });
  });

  it("never returns less than the fixed chrome", () => {
    expect(choiceHeight([])).toBe(FIXED);
  });

  /** The real shape from the screenshot: three options, each with a description. */
  it("reserves eight rows for three described options, where it used to reserve six", () => {
    const opts = [
      { label: "Strict", description: "Recommended for a craft-focused project where the bar is the point" },
      { label: "Advisory", description: "Lighter-weight, trusts contributor judgment" },
      { label: "TODO", description: "If the real adoption date will be decided later" },
    ];
    expect(choiceHeight(opts, 100)).toBe(6 + FIXED);
    expect(choiceHeight(opts, 100)).toBeGreaterThan(3 + 3); // the old formula
  });
});

/**
 * An option the user cannot read is not a choice they can make.
 *
 * Options were truncated to the list column — 40% of the width when a preview is present — so three long
 * options all ended in "…" and none of them said enough to choose between. They wrap now, which means the
 * height has to count the wrapped rows or the box goes back to painting over the question above it.
 */
describe("long options wrap rather than truncate", () => {
  const LONG = "Build a DataProvider interface. v1 ships a LocalStorageProvider. Design and stub an HttpProvider "
    + "behind the same interface so the swap is a one-line change later.";

  it("reserves more than one row for an option that wraps", () => {
    const one = choiceHeight([{ label: "short" }], 100);
    const many = choiceHeight([{ label: LONG }], 100);
    expect(many).toBeGreaterThan(one);
  });

  it("reserves more rows in a narrow list column than a wide one", () => {
    const withPreview = [{ label: LONG, preview: "x" }];
    // With a preview the list gets 40% of the width, so the same text wraps to more rows.
    expect(choiceHeight(withPreview, 100)).toBeGreaterThan(choiceHeight([{ label: LONG }], 100));
  });

  it("counts a wrapped description too", () => {
    const a = choiceHeight([{ label: "x" }], 100);
    const b = choiceHeight([{ label: "x", description: LONG }], 100);
    expect(b - a).toBeGreaterThan(1);
  });
});

describe("wrapPlain", () => {
  it("breaks on spaces within the width", () => {
    expect(wrapPlain("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("keeps a short line whole", () => {
    expect(wrapPlain("short", 40)).toEqual(["short"]);
  });

  /** A single word longer than the column is cut rather than pushing the box wider than the terminal. */
  it("cuts a word that cannot fit", () => {
    expect(wrapPlain("aaaaaaaaaaaa", 10)).toEqual(["aaaaaaaaaa", "aa"]);
  });

  /** A column narrower than this cannot hold a readable word, so the width has a floor. */
  it("never wraps narrower than the floor", () => {
    expect(wrapPlain("aaaaaaaaaaaa", 2)).toEqual(["aaaaaaaa", "aaaa"]);
  });

  it("preserves explicit line breaks", () => {
    expect(wrapPlain("a\nb", 40)).toEqual(["a", "b"]);
  });

  it("empty text is one empty line, not none", () => {
    expect(wrapPlain("", 40)).toEqual([""]);
  });
});

/**
 * A long question must render in full, whatever its length.
 *
 * The question is markdown-wrapped to the terminal width, so it never overflows sideways — what corrupted it
 * on screen was the choice box under-reserving its own height and painting over the region above. These
 * assert the wrapping side of that contract: no line ever exceeds the body width, at any width, however long
 * the question.
 */
describe("a paragraph-long question wraps rather than overflowing", () => {
  const PARAGRAPH =
    "The constitution mandates httpResource, resource(), and websocket streaming — but also \"no backend, "
    + "localStorage only.\" These directly conflict: those are network primitives with nothing to talk to. "
    + "How do you want to resolve this for v1? (This is the single biggest architectural decision.)";

  it.each([60, 80, 120, 200])("fits the body width at cols=%i", (cols) => {
    const width = pendingBodyWidth(cols);
    for (const line of flattenMarkdown(PARAGRAPH, width)) {
      expect(line.map((s) => s.text).join("").length).toBeLessThanOrEqual(width);
    }
  });

  it("uses more lines on a narrower terminal rather than cutting text", () => {
    const narrow = flattenMarkdown(PARAGRAPH, pendingBodyWidth(60)).length;
    const wide = flattenMarkdown(PARAGRAPH, pendingBodyWidth(200)).length;
    expect(narrow).toBeGreaterThan(wide);
  });

  /** Nothing is dropped: every word of the question survives the wrap. */
  it("keeps the whole question", () => {
    const joined = flattenMarkdown(PARAGRAPH, pendingBodyWidth(80))
      .map((l) => l.map((s) => s.text).join("")).join(" ");
    expect(joined).toContain("httpResource");
    expect(joined).toContain("single biggest architectural decision");
  });
});
