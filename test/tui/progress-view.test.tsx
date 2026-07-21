import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { phaseLabel } from "../../src/tui/labels.js";
import { RunningHorse, ProgressView } from "../../src/tui/progress-view.js";

describe("faz etiketleri + koşan at", () => {
  it("phaseLabel bilinen fazı çevirir, bilinmeyeni aynen döner", () => {
    expect(phaseLabel("waves")).toBe("Coding…");
    expect(phaseLabel("upstream")).toContain("Refining");
    expect(phaseLabel("bilinmeyen-faz")).toBe("bilinmeyen-faz");
  });

  it("RunningHorse spinner render eder (0 top + o track, emoji değil)", () => {
    const r = render(<RunningHorse />);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("0"); // hareketli top
    expect(f).toContain("o"); // track
    expect(f).not.toContain("🐎");
    r.unmount();
  });

  it("ProgressView faz-etiketi + at gösterir", () => {
    const r = render(<ProgressView phase="waves" />);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Coding");
    expect(f).toContain("0");
    r.unmount();
  });
});
