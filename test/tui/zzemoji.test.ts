import { describe, it, expect } from "vitest";
import { padNarrowEmoji, parseInline } from "../../src/tui/markdown.js";

// ⚠️ is U+26A0 + U+FE0F: its base codepoint is NARROW, but the variation selector asks for the emoji
// presentation and terminals draw it two columns wide. Ink measured one, so the following space was overdrawn
// by the glyph's second column and the message collided with the icon.
describe("padNarrowEmoji", () => {
  it("restores the gap after a variation-selector emoji", () => {
    expect(padNarrowEmoji("⚠️ Define models")).toBe("⚠️  Define models");
  });

  it("leaves naturally wide emoji alone — they already measure correctly", () => {
    for (const line of ["📋 Define models", "✅ Council approved", "🧠 memory", "🔨 Judge ruled"]) {
      expect(padNarrowEmoji(line)).toBe(line);
    }
  });

  it("only touches the START of a line", () => {
    expect(padNarrowEmoji("note: ⚠️ inline")).toBe("note: ⚠️ inline");
  });

  it("leaves plain text and empty lines untouched", () => {
    expect(padNarrowEmoji("just text")).toBe("just text");
    expect(padNarrowEmoji("")).toBe("");
  });

  it("does nothing when the emoji is not followed by a space", () => {
    expect(padNarrowEmoji("⚠️Define")).toBe("⚠️Define");
  });
});

describe("parseInline applies the padding before splitting", () => {
  // The real note shape: emoji, space, then a BOLD title. The gap must survive into the first segment.
  it("keeps the icon separated from a bold title", () => {
    const segs = parseInline("⚠️ **Define models** — the implementer wrote nothing.");
    expect(segs[0].text).toBe("⚠️  ");
    expect(segs[1]).toEqual({ text: "Define models", bold: true });
  });

  it("does not disturb a naturally wide icon", () => {
    const segs = parseInline("📋 **Define models** → In progress");
    expect(segs[0].text).toBe("📋 ");
  });
});
