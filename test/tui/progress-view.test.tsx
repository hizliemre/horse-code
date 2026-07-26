import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { phaseLabel } from "../../src/tui/labels.js";
import { RunningHorse, ProgressView, ShimmerText } from "../../src/tui/progress-view.js";

// The shimmer wraps each character in its own color span → strip ANSI to read the plain text back.
const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");

describe("phase labels + running horse", () => {
  it("phaseLabel translates a known phase, returns an unknown one as-is", () => {
    expect(phaseLabel("waves")).toBe("Coding…");
    expect(phaseLabel("upstream")).toContain("refining");
    expect(phaseLabel("chat")).toContain("zottiring");
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

  it("ShimmerText renders the full text (chars tinted individually)", () => {
    const r = render(<ShimmerText text="hello" />);
    expect(clean(r.lastFrame())).toContain("hello");
    r.unmount();
  });

  it("ProgressView shows the phase label + the ball", () => {
    const r = render(<ProgressView phase="waves" />);
    const f = clean(r.lastFrame());
    expect(f).toContain("Coding");
    expect(f).toContain("0");
    r.unmount();
  });

  it("while running, shows live elapsed + a broken-out token count (↑prompt ↓completion · N calls)", () => {
    const meta = { model: "", promptTokens: 1234, completionTokens: 456, cachedTokens: 0, calls: 3, startedAt: Date.now() - 12_000, running: true };
    const r = render(<ProgressView phase="chat" meta={meta} />);
    const f = clean(r.lastFrame());
    expect(f).toMatch(/\(\d+s · ↑1\.2k ↓456 · 3 calls\)/);
    r.unmount();
  });

  it("no metrics parens when there is no running meta", () => {
    const r = render(<ProgressView phase="chat" />);
    expect(clean(r.lastFrame())).not.toContain("tokens");
    r.unmount();
  });

  it("during refine, the label carries the refiner model; during chat it does not", () => {
    const refine = render(<ProgressView phase="upstream" refinerModel="prov/refine-model" />);
    expect(clean(refine.lastFrame())).toContain("(prov/refine-model)");
    refine.unmount();
    const chat = render(<ProgressView phase="chat" refinerModel="prov/refine-model" />);
    const c = clean(chat.lastFrame());
    expect(c).toContain("zottiring");
    expect(c).not.toContain("refine-model");
    chat.unmount();
  });
});
