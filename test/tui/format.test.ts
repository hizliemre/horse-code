import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration, relTime, stripThinking } from "../../src/tui/format.js";
import { donePhrase } from "../../src/tui/labels.js";

describe("fmtTokens", () => {
  it("compacts thousands, leaves small counts as-is", () => {
    expect(fmtTokens(900)).toBe("900");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(0)).toBe("0");
  });
  it("rolls over to M and B instead of staying in k (21914000 → 21.9M, not 21914.0k)", () => {
    expect(fmtTokens(21_914_000)).toBe("21.9M");
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(3_200_000_000)).toBe("3.2B");
    expect(fmtTokens(999_999)).toBe("1000.0k"); // just under 1M still k (rounds to 1000.0k)
  });
});

describe("fmtDuration", () => {
  it("shows seconds under a minute, 'Xm XXs' from a minute up (zero-padded seconds)", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(83_000)).toBe("1m 23s");
    expect(fmtDuration(65_000)).toBe("1m 05s");
    expect(fmtDuration(0)).toBe("0s");
  });
});

describe("relTime", () => {
  it("buckets into just now / m / h / d ago", () => {
    const now = 1_000_000_000_000;
    expect(relTime(now - 10_000, now)).toBe("just now"); // <1m
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("donePhrase", () => {
  it("maps a phase to its past-tense completion verb; falls back to 'done'", () => {
    expect(donePhrase("chat")).toBe("zottired");
    expect(donePhrase("upstream")).toBe("refined");
    expect(donePhrase("whatever")).toBe("done");
  });
});

/**
 * Some models emit `<think>…</think>` in the ordinary text stream. It is not an answer and was never meant to
 * be read: a by-the-way reply came back on screen as `</think>Şu an 65 görev merge edildi…`, the closing tag
 * in front of the sentence because the opening one had streamed past earlier.
 */
describe("stripThinking", () => {
  it("removes a complete thinking block", () => {
    expect(stripThinking("<think>weighing it up</think>The answer is 42.")).toBe("The answer is 42.");
  });

  /** The reported case: the run began before anything was watching, so only the closing tag arrives. */
  it("drops everything up to a lone closing tag", () => {
    expect(stripThinking("</think>Şu an 65 görev merge edildi")).toBe("Şu an 65 görev merge edildi");
  });

  /**
   * Mid-stream, everything after an unclosed tag really IS thinking. Showing it and retracting it a second
   * later is worse than waiting for the answer.
   */
  it("hides an unfinished thinking block until it closes", () => {
    expect(stripThinking("Here it is. <think>but wait, actually")).toBe("Here it is.");
  });

  it("leaves ordinary text exactly as it is", () => {
    expect(stripThinking("63 tasks in TODO, 5 running.")).toBe("63 tasks in TODO, 5 running.");
    expect(stripThinking("")).toBe("");
  });

  it("handles several blocks, and is not fooled by case", () => {
    expect(stripThinking("<THINK>a</THINK>one <think>b</think>two")).toBe("one two");
  });

  /** Markdown is the point — the chat renders it, so nothing may be mangled on the way through. */
  it("does not touch markdown", () => {
    const md = "**65 merged**\n- 5 running\n- `24` waiting";
    expect(stripThinking(md)).toBe(md);
  });
});
