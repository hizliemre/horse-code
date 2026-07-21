import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration } from "../../src/tui/format.js";
import { donePhrase } from "../../src/tui/labels.js";

describe("fmtTokens", () => {
  it("compacts thousands, leaves small counts as-is", () => {
    expect(fmtTokens(900)).toBe("900");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(0)).toBe("0");
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

describe("donePhrase", () => {
  it("maps a phase to its past-tense completion verb; falls back to 'done'", () => {
    expect(donePhrase("chat")).toBe("zottired");
    expect(donePhrase("upstream")).toBe("refined");
    expect(donePhrase("whatever")).toBe("done");
  });
});
