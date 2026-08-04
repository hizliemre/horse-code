import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChoiceInput } from "../../src/tui/components.js";

/**
 * The options a real decision arrives with are sentences, not words, and they come with a preview.
 *
 * Reported from a live run with a screenshot: four approach options rendered side by side with a preview
 * pane, and not one of them showed a marker — every line sat at the same indent, so nothing said which was
 * selected, or that the list was a control at all.
 */
describe("a long option with a preview still shows which one is selected", () => {
  const CHOICES = [
    {
      label: "Normalize/decode the description to real HTML right before rendering, through a proper "
        + "rich-HTML allowlist — works no matter which path encoded it",
      preview: "step-summary decodes entities if present, then renders sanitized rich HTML "
        + "(p/ul/ol/li/strong/em/h3/h4). Self-contained, no backend dependency.",
    },
    {
      label: "Trace to the exact encoding point (backend serialization or AI mapping) and emit/store true "
        + "HTML so every consumer gets clean HTML",
      preview: "one origin fixed; every consumer benefits",
    },
  ];

  const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

  it("marks the selected option on the line its text starts on", () => {
    const { lastFrame } = render(
      <ChoiceInput options={CHOICES} multiSelect={false} cols={220} onSubmit={() => {}} onEscape={() => {}} />,
    );
    const frame = plain(lastFrame() ?? "");
    const marked = frame.split("\n").find((l) => l.includes("(*)")) ?? "";
    expect(marked).toContain("Normalize/decode");    // the marker sits with its own first words
    expect(frame).toContain("( )");                  // …and the other is visibly unselected
  });

  /**
   * The marker costs six columns, and if the label is wrapped to the full box width the first line overflows
   * — the terminal then re-wraps it, pushing words to a column the component never chose and leaving the
   * marker alone on a line of its own.
   */
  it("leaves room for the marker, so the terminal never has to re-wrap the first line", () => {
    for (const cols of [120, 160, 200, 220, 260]) {
      const { lastFrame } = render(
        <ChoiceInput options={CHOICES} multiSelect={false} cols={cols} onSubmit={() => {}} onEscape={() => {}} />,
      );
      const frame = plain(lastFrame() ?? "");
      for (const line of frame.split("\n")) {
        expect(line.length, `cols=${cols}: ${line.slice(0, 46)}`).toBeLessThanOrEqual(cols);
      }
      // …and at every one of those widths the marker is still on its label's own line.
      const marked = frame.split("\n").find((l) => l.includes("(*)")) ?? "";
      expect(marked, `cols=${cols}`).toContain("Normalize");
    }
  });
});
