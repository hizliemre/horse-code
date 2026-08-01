import { describe, it, expect } from "vitest";
import { choiceHeight, wrapPlain, pendingBodyWidth, dropToFit, MIN_VIEWPORT_ROWS, NOTE_ROWS, noteLines, RADIO_ON, RADIO_OFF, CURSOR } from "../../src/tui/components.js";
import { flattenMarkdown } from "../../src/tui/lines.js";

/**
 * The layout reserved fewer rows than the component painted, so Ink drew over the region above it: the
 * question the user was answering got overwritten, and option text collided mid-line with the option below.
 *
 * The formula said `optionCount + 3`, from a version that drew one row per option and had no notes line. It
 * then grew a description row per option, a notes row, and a preview panel — and none were added here.
 */
describe("choiceHeight matches what ChoiceInput draws", () => {
  // The note area is a fixed block, not one line — see NOTE_ROWS.
  const FIXED = 2 /* border */ + NOTE_ROWS /* notes */ + 1 /* hint */;

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

  /**
   * Nothing is dropped: every word survives the wrap.
   *
   * Asserted on the WORDS, not on the spacing — a wrap boundary leaves whatever whitespace it leaves, and a
   * test that breaks when the wrap lands one character earlier is testing the wrap position rather than the
   * property that matters.
   */
  it("keeps every word of the question", () => {
    const words = (t: string): string[] => t.split(/\s+/).filter(Boolean);
    const rendered = flattenMarkdown(PARAGRAPH, pendingBodyWidth(80))
      .map((l) => l.map((s) => s.text).join(" ")).join(" ");
    expect(words(rendered)).toEqual(words(PARAGRAPH));
  });
});

/**
 * The panel's rows are counted by the same function that draws them.
 *
 * They disagreed once already on the pending question, and Ink painted the bottom region straight over the
 * transcript — the user answered a question they could no longer read.
 */
describe("dropToFit", () => {
  const panels = () => [
    { name: "monitor", height: 8 },
    { name: "next", height: 4 },
    { name: "agents", height: 11 },
    { name: "aside", height: 3 },
  ];

  it("keeps everything when the terminal has room", () => {
    expect(dropToFit(60, 10, panels())).toEqual(new Set(["monitor", "next", "agents", "aside"]));
  });

  /** The run's own numbers go before the agents' names; everything goes before the input. */
  it("drops in the order given, and only as far as it must", () => {
    const keep = dropToFit(36, 10, panels()); // 10 + 26 = 36; needs 4 more rows
    expect(keep.has("monitor")).toBe(false);
    expect(keep.has("agents")).toBe(true);
    expect(keep.has("aside")).toBe(true);
  });

  /** It stops the moment it fits — a panel that still has room is not thrown away for tidiness. */
  it("keeps whatever still fits after the bigger ones are gone", () => {
    const keep = dropToFit(18, 10, panels()); // 10 + aside(3) + 3 history + 1 hint = 17 ≤ 18
    expect([...keep]).toEqual(["aside"]);
  });

  it("gives up everything optional when even the smallest will not fit", () => {
    expect(dropToFit(13, 10, panels()).size).toBe(0);
  });

  /** The point of the whole exercise: the frame must never be taller than the screen. */
  it("always leaves room for the input, the hint line and some history", () => {
    for (const rows of [12, 16, 20, 24, 30, 40, 50]) {
      const keep = dropToFit(rows, 10, panels());
      const used = 10 + panels().filter((p) => keep.has(p.name)).reduce((n, p) => n + p.height, 0);
      // Either it fits with history to spare, or everything optional is already gone.
      expect(used + MIN_VIEWPORT_ROWS + 1 <= rows || keep.size === 0).toBe(true);
    }
  });

  it("does not count a panel that is not being shown", () => {
    const keep = dropToFit(30, 10, [{ name: "monitor", height: 0 }, { name: "agents", height: 11 }]);
    expect(keep.has("agents")).toBe(true); // 10 + 11 + 4 = 25 ≤ 30
    expect(keep.has("monitor")).toBe(true); // zero-height: nothing to gain by dropping it
  });
});

/**
 * The note was one `truncate-end` line, so a note longer than the terminal was cut with an ellipsis and the
 * caret went with it — the user could not see what they were typing.
 */
describe("noteLines", () => {
  it("offers the hint slot when nothing is typed, and still fills the block", () => {
    const lines = noteLines("", false, 60);
    expect(lines[0]).toBeNull();
    expect(lines).toHaveLength(NOTE_ROWS);
  });

  it("shows the caret on the last line however long the note grows", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const lines = noteLines(long, true, 40);
    expect(lines).toHaveLength(NOTE_ROWS);
    expect(lines.at(-1)).toContain("▌");
  });

  it("keeps the note's TAIL — the part being written", () => {
    const lines = noteLines("alpha beta gamma delta epsilon zeta eta theta iota kappa", true, 24);
    expect(lines.join(" ")).toContain("kappa");
  });

  it("never returns more rows than the block reserves", () => {
    for (const w of [20, 40, 80, 200]) {
      expect(noteLines("x".repeat(500), true, w)).toHaveLength(NOTE_ROWS);
    }
  });

  it("shows a short note as-is, without a caret when not editing", () => {
    expect(noteLines("short", false, 60)[0]).toBe("short");
  });
});

/**
 * The markers were `◉`, `○` and `›` — all three East Asian AMBIGUOUS width. A terminal that draws ambiguous
 * glyphs two columns wide disagrees with the single column `string-width` counts, and the row carrying them
 * is laid out to the wrong width. Reported from a real terminal: the marker line of every option came out
 * blank, so the user pressed Enter on a choice they could not see.
 *
 * The multi-select markers were `[x]`/`[ ]` all along and never broke — that is the evidence these follow.
 */
describe("selection markers are unambiguous width", () => {
  const AMBIGUOUS = /[\u2000-\u23FF\u25A0-\u27BF\u2E80-\uA4CF\uFE10-\uFE6F\uFF00-\uFF60]/;

  it("uses no glyph a terminal may draw double-width", () => {
    for (const g of [RADIO_ON, RADIO_OFF, CURSOR]) {
      expect(g).not.toMatch(AMBIGUOUS);
      expect(g).toMatch(/^[\x20-\x7E]+$/); // printable ASCII only
    }
  });

  it("keeps the radio and the checkbox the same width, so rows line up", () => {
    expect(RADIO_ON.length).toBe(RADIO_OFF.length);
    expect(RADIO_ON.length).toBe("[x] ".trimEnd().length);
  });

  it("still distinguishes the selected option from the rest", () => {
    expect(RADIO_ON).not.toBe(RADIO_OFF);
  });
});
