import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration, relTime } from "../../src/tui/format.js";
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
