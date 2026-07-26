import { describe, it, expect } from "vitest";
import { choiceHeight } from "../../src/tui/components.js";

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
