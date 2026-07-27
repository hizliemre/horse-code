import { describe, it, expect } from "vitest";
import { closesHelp } from "../../src/tui/components.js";

/**
 * The help overlay REPLACES the input line, so nothing else can close it.
 *
 * Its key test compared whole chunks for equality, and a chunk is not a keystroke: fast typing, a paste and
 * a terminal that batches its writes all deliver several bytes at once. None of those forms matched, and the
 * overlay stayed up.
 */
describe("closesHelp", () => {
  it("accepts the keys the overlay documents", () => {
    expect(closesHelp("q")).toBe(true);
    expect(closesHelp("?")).toBe(true);
    expect(closesHelp("\x1b")).toBe(true);
  });

  it("accepts them batched, which is how a terminal often sends them", () => {
    expect(closesHelp("q\r")).toBe(true);
    expect(closesHelp("q\n")).toBe(true);
    expect(closesHelp("Q\r\n")).toBe(true);
  });

  /** It is what anyone reaches for when a screen will not go away. */
  it("accepts Ctrl+C", () => {
    expect(closesHelp("\x03")).toBe(true);
  });

  it("ignores ordinary typing", () => {
    expect(closesHelp("a")).toBe(false);
    expect(closesHelp("hello")).toBe(false);
  });
});
