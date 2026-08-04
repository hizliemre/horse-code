import { describe, it, expect } from "vitest";


/**
 * The preview panel is the explanation; cutting it at one line makes it decoration.
 *
 * It was rendered with `wrap="truncate-end"`, so a description wider than its column lost everything past
 * the first line — reported with the text ending in a bare `…` while two thirds of the box sat empty
 * beneath it.
 */
describe("the preview beside a choice", () => {
  it("wraps to its box instead of being cut at one line", async () => {
    const { previewLines } = await import("../../src/tui/components.js");
    const long = "Use this if `dotnet run --project src/host/host.csproj --launch-profile mock` is running, "
      + "resources are healthy, and `http://localhost:4200/products/new` opens.";
    const lines = previewLines(long, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 40)).toBe(true);
    expect(lines.join(" ")).toContain("opens.");        // …the end is still there
  });

  it("keeps the author's own line breaks", async () => {
    const { previewLines } = await import("../../src/tui/components.js");
    expect(previewLines("one\n\ntwo", 40)).toEqual(["one", "", "two"]);
  });

  /** A long preview must not push the list — or the hint line under it — off the terminal. */
  it("stops at a height a list can sit beside", async () => {
    const { previewLines, PREVIEW_ROWS } = await import("../../src/tui/components.js");
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const lines = previewLines(many, 40);
    expect(lines).toHaveLength(PREVIEW_ROWS);
    expect(lines[lines.length - 1]).toBe("…");
  });

  it("says nothing for an empty preview", async () => {
    const { previewLines } = await import("../../src/tui/components.js");
    expect(previewLines("", 40)).toEqual([""]);
  });
});
