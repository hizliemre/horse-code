import { describe, it, expect } from "vitest";
import { parseKittyKey } from "../../src/tui/keys.js";

describe("parseKittyKey", () => {
  it("maps kitty numpad codepoints to characters", () => {
    expect(parseKittyKey("\x1b[57399u")).toEqual({ type: "char", char: "0" });
    expect(parseKittyKey("\x1b[57408u")).toEqual({ type: "char", char: "9" });
    expect(parseKittyKey("\x1b[57409u")).toEqual({ type: "char", char: "." });
    expect(parseKittyKey("\x1b[57410u")).toEqual({ type: "char", char: "/" });
  });

  it("recognizes numpad Enter and Escape", () => {
    expect(parseKittyKey("\x1b[57414u")).toEqual({ type: "enter" });
    expect(parseKittyKey("\x1b[27u")).toEqual({ type: "escape" });
  });

  it("ignores modifier fields (\\x1b[<cp>;<mod>u)", () => {
    expect(parseKittyKey("\x1b[57399;2u")).toEqual({ type: "char", char: "0" });
  });

  it("returns 'other' for unmapped CSI-u functional keys (e.g. Ctrl+C)", () => {
    expect(parseKittyKey("\x1b[99;5u")).toEqual({ type: "other" });
  });

  it("returns undefined for non-CSI-u input (legacy escapes, plain chars)", () => {
    expect(parseKittyKey("\x1b[A")).toBeUndefined(); // legacy arrow
    expect(parseKittyKey("\x1b[5~")).toBeUndefined(); // PageUp
    expect(parseKittyKey("a")).toBeUndefined();
    expect(parseKittyKey("\r")).toBeUndefined();
  });
});

/**
 * While a job runs, Ctrl+C did nothing at all.
 *
 * `InputLine` returns early on it (`if (runningRef.current) return`) so that App can own the gesture — and
 * App never claimed it. The gap only bites where the job STOPS for an answer: a pending question owns the
 * screen, the input is the answer box, and there is no way out of it. Reported from a live run: "soru ekranı
 * geldiğinde cevap vermeden çıkamıyorum, ctrl+c çalışmıyor".
 */
describe("Ctrl+C while a job is running", () => {
  it("is recognised in both the raw and the CSI-u form the terminals send", async () => {
    const { isInterrupt } = await import("../../src/tui/keys.js");
    expect(isInterrupt("\x03")).toBe(true);
    expect(isInterrupt("\x1b[99;5u")).toBe(true);
    expect(isInterrupt("c")).toBe(false);
    expect(isInterrupt("\x1b")).toBe(false);
  });
});
