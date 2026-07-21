import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { phaseLabel } from "../../src/tui/labels.js";
import { RunningHorse, ProgressView } from "../../src/tui/progress-view.js";

describe("faz etiketleri + koşan at", () => {
  it("phaseLabel bilinen fazı çevirir, bilinmeyeni aynen döner", () => {
    expect(phaseLabel("waves")).toBe("Kodlanıyor…");
    expect(phaseLabel("upstream")).toContain("rafine");
    expect(phaseLabel("bilinmeyen-faz")).toBe("bilinmeyen-faz");
  });

  it("RunningHorse 🐎 render eder", () => {
    const r = render(<RunningHorse />);
    expect(r.lastFrame() ?? "").toContain("🐎");
    r.unmount();
  });

  it("ProgressView faz-etiketi + at gösterir", () => {
    const r = render(<ProgressView phase="waves" />);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Kodlanıyor");
    expect(f).toContain("🐎");
    r.unmount();
  });
});
