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

/**
 * Which option is selected is said on every row it owns, not once.
 *
 * The marker row has gone missing in a real terminal three times, under three different diagnoses — ambiguous
 * -width glyphs, a nested `<Text>`, and a row wider than its content area. Each was real and each was fixed;
 * the symptom came back. Reported the third time with a screenshot of a three-option question in which no
 * option carried a marker at all, while the box, the notes row and the key hints all rendered.
 *
 * A single row carrying the whole answer to "which one am I about to pick" is the design fault underneath
 * that. A gutter down the option cannot be erased by losing one row.
 */
describe("the selection gutter", () => {
  const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, "");
  const long = {
    label: "Y kaydı kendi tenant'ında kaydeder; güvenilir olay X hedef tenant'ına gönderilir ve X aynasını güncellir.",
    description: "Artı: tenant filtresi delinmez, X'in okuması basit kalır.",
  };
  const other = { label: "Y işleminde X'in özet satırı güncellenir.", description: "Eksi: kuyruk." };

  const frameOf = (cols: number): string[] => {
    const { lastFrame } = render(
      <ChoiceInput cols={cols} multiSelect={false} onSubmit={() => {}} options={[long, other]} />);
    return strip(lastFrame() ?? "").split("\n");
  };

  it("marks every wrapped line of the selected option, not just the first", () => {
    const rows = frameOf(100).filter((l) => l.includes("tenant") || l.includes("güncellir") || l.includes("Artı"));
    expect(rows.length).toBeGreaterThan(2);          // it wraps, and has a description
    for (const r of rows) expect(r).toMatch(/│\s*>/);
  });

  it("leaves the unselected option's rows without a cursor", () => {
    const rows = frameOf(100).filter((l) => l.includes("özet satırı") || l.includes("kuyruk"));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r).not.toMatch(/│\s*>/);
  });

  it("still carries the radio marker on the first line of each option", () => {
    const f = frameOf(100).join("\n");
    expect(f).toContain("(*)");
    expect(f).toContain("( )");
  });

  /** The gutter is two columns on every row, so nothing shifts as the cursor moves. */
  it("keeps every row of the list the same width", () => {
    const rows = frameOf(100).filter((l) => l.startsWith("│"));
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });
});
