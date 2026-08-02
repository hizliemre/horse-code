import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChoiceInput, wrapPlain, oneLine } from "../../src/tui/components.js";

/**
 * The one the user reported four separate times, each time correctly, and which I mis-diagnosed three times
 * by looking at how the row was rendered instead of at what it was rendering.
 *
 * A model's `ask_user` options arrive as prose, and prose carries newlines. `wrapPlain` emits one line per
 * `\n` including empty ones, so a label beginning with a newline wrapped to `["", "…"]` — the marker and the
 * cursor were printed onto that empty first line, and every visible word landed on a continuation row.
 * Nothing was missing from the frame. The marker was simply on a blank line above its own text.
 */
describe("a choice always shows which one is selected", () => {
  it("puts the marker on the same line as the label, even when the label arrives with newlines", () => {
    const choices = [
      { label: "\nSkill listesi çıkar; ilkesel çekirdek kalır." },
      { label: "Log pipeline kapısı\nIV→V'e taşınır." },
    ];
    const { lastFrame } = render(
      <ChoiceInput options={choices} multiSelect={false} cols={100} onSubmit={() => {}} onEscape={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    const marked = frame.split("\n").find((l) => l.includes("(*)")) ?? "";
    expect(marked).toContain("Skill listesi");   // the marker and its text, on one line
    expect(frame).toContain("( )");              // …and the unselected one is visibly unselected
  });

  it("normalises a label to a single line", () => {
    expect(oneLine("\n  Log pipeline\n  kapısı  taşınır.  ")).toBe("Log pipeline kapısı taşınır.");
  });

  /** The mechanism, stated on its own so the reason cannot be lost in a refactor. */
  it("wrapPlain emits an empty first line for a leading newline — which is why labels are normalised", () => {
    expect(wrapPlain("\nhello", 40)).toEqual(["", "hello"]);
    expect(wrapPlain(oneLine("\nhello"), 40)).toEqual(["hello"]);
  });
});
