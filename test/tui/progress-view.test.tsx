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

/**
 * Nothing is ever drawn beneath the running indicator.
 *
 * The live write indicator had its own row below it, so the shimmer was never the last thing before the
 * input — something kept appearing under it. It rides on the same line now, and that line truncates: if it
 * wrapped, the overflow would land below the indicator again and reintroduce exactly what was removed.
 */
describe("the progress row is exactly one line", () => {
  const meta = {
    running: true, startedAt: Date.now() - 43 * 60_000,
    promptTokens: 52e6, completionTokens: 525_300, cachedTokens: 0, calls: 2035,
  };
  const rows = (el: React.ReactElement): number =>
    (render(el).lastFrame() ?? "").split("\n").filter((l) => l.trim()).length;

  it("with nothing being written", () => {
    expect(rows(<ProgressView phase="coding" meta={meta as never} />)).toBe(1);
  });

  it("while a file is being written", () => {
    expect(rows(
      <ProgressView phase="coding" meta={meta as never} live="writing error-notice.component.spec.ts · 200 chars" />,
    )).toBe(1);
  });

  it("with a live label long enough to overflow any terminal", () => {
    expect(rows(<ProgressView phase="coding" meta={meta as never} live={"writing ".concat("x".repeat(400))} />)).toBe(1);
  });

  it("still shows which file is being written", () => {
    const frame = render(
      <ProgressView phase="coding" meta={meta as never} live="writing error-notice.spec.ts" />,
    ).lastFrame() ?? "";
    expect(frame).toContain("error-notice");
  });
});
