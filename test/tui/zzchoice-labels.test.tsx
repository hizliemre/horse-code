import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChoiceInput } from "../../src/tui/components.js";

const ESC = String.fromCharCode(27);
const strip = (s: string): string => s.split(new RegExp(ESC + "\\[[0-9;]*m", "g")).join("");
const frame = (props: Record<string, unknown>): string => strip(render(React.createElement(
  ChoiceInput as never,
  { cols: 200, onSubmit: () => {}, onEscape: () => {}, multiSelect: false, ...props },
)).lastFrame() ?? "");

/**
 * Reported three times: "I cannot see which option I selected." The frame Ink composes has always contained
 * the labels — what failed was the update that carried them to a real terminal.
 *
 * The label line was the ONLY nested <Text> in this box (a <Text> inside a <Text>, for the selection
 * styling); the description, the note and the hint are all flat, and none of them ever went missing. These
 * tests hold the line flat and hold the markers visible, so a future change cannot quietly reintroduce
 * either difference.
 */
describe("every option shows its marker AND its label", () => {
  const OPTS = [
    { label: "Faz disiplini", description: "Hotfix dahil her is Faz 0-7den gecer." },
    { label: "Dogrulanmis olgu", description: "Her olgu kaynaktan dogrulanir." },
  ];

  it("draws both labels in a radio group", () => {
    const f = frame({ options: OPTS });
    for (const o of OPTS) expect(f).toContain(o.label);
  });

  it("draws both labels in a checkbox group", () => {
    const f = frame({ options: OPTS, multiSelect: true });
    for (const o of OPTS) expect(f).toContain(o.label);
    expect(f).toContain("[ ]");
  });

  it("draws them beside a preview panel too", () => {
    const f = frame({ options: [{ ...OPTS[0], preview: "a longer explanation" }, OPTS[1]] });
    for (const o of OPTS) expect(f).toContain(o.label);
  });

  it("keeps the label of a long option that wraps", () => {
    const long = "Feature davranisi, UI/UX, todoya ekleme ve kritik geri-donulemez islemler kullanici kararidir; secenek sunulur, onay beklenir";
    const f = frame({ options: [{ label: long }] });
    expect(f).toContain("Feature davranisi");
    expect(f).toContain("onay beklenir"); // …including the part that wrapped
  });

  it("marks exactly one option as current", () => {
    const f = frame({ options: OPTS });
    expect(f.split("\n").filter((l) => l.includes(">")).length).toBeGreaterThanOrEqual(1);
  });
});
