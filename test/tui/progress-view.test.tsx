import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { phaseLabel } from "../../src/tui/labels.js";
import { RunningHorse, ProgressView } from "../../src/tui/progress-view.js";

describe("phase labels + running horse", () => {
  it("phaseLabel translates a known phase, returns an unknown one as-is", () => {
    expect(phaseLabel("waves")).toBe("Coding…");
    expect(phaseLabel("upstream")).toContain("Refining");
    expect(phaseLabel("unknown-phase")).toBe("unknown-phase");
  });

  it("RunningHorse renders the spinner (0 ball + o track, not an emoji)", () => {
    const r = render(<RunningHorse />);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("0"); // moving ball
    expect(f).toContain("o"); // track
    expect(f).not.toContain("🐎");
    r.unmount();
  });

  it("ProgressView shows the phase label + the horse", () => {
    const r = render(<ProgressView phase="waves" />);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Coding");
    expect(f).toContain("0");
    r.unmount();
  });
});
