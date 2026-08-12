import { describe, it, expect } from "vitest";
import { whyNotFound, NEAR_MISS_CHARS } from "../../src/tools/edit.js";

/**
 * Why the string was not there, instead of only that it was not.
 *
 * Measured across six consecutive runs on one project: 17 of 68 `edit_file` calls failed with
 * `oldString not found` — by `coder`, `designer` and `tester` alike. One edit in four, each costing a turn
 * and telling the agent nothing it did not already know. Ten of them were the same test report, edited over
 * and over as scenarios were recorded into it.
 */
describe("a failed edit says why", () => {
  const file = "# Report\n\n## F4 — step-media\n\tstatus: pending\n\tevidence: none yet\n\n## F5\n";

  it("names read_file's display prefixes when they were pasted back in", () => {
    const said = whyNotFound(file, "  12\t## F4 — step-media\n  13\t\tstatus: pending");
    expect(said).toContain("display prefixes");
    expect(said).toContain("Strip the number");
  });

  it("quotes the file's real bytes when only the whitespace differed", () => {
    // The agent sent spaces where the file has a tab — the text is there, the bytes are not.
    const said = whyNotFound(file, "## F4 — step-media\n    status: pending");
    expect(said).toContain("whitespace differs");
    expect(said).toContain("line 3");
    expect(said).toContain("\tstatus: pending");   // …exactly as the file has it, ready to paste
  });

  it("shows what is there now when the anchor survived but the rest moved on", () => {
    const said = whyNotFound(file, "## F4 — step-media\n\tstatus: FAILED\n\tevidence: none yet");
    expect(said).toContain("line 3");
    expect(said).toContain("what follows it is not what you sent");
    expect(said).toContain("status: pending");     // what the file actually holds
  });

  it("says to read the file again when nothing of it is there at all", () => {
    const said = whyNotFound(file, "## F9 — a scenario that does not exist\nstatus: pending");
    expect(said).toContain("Read it again");
    expect(said).toContain("changed since you last saw it");
  });

  it("refuses to quote the whole file back — an error is not a re-send", () => {
    const big = `## F4 — step-media\n${"x".repeat(5000)}`;
    const said = whyNotFound(`## F4 — step-media\n${"x".repeat(5000)}\n`, `## F4 — step-media\n${"y".repeat(50)}`);
    expect(said.length).toBeLessThan(NEAR_MISS_CHARS + 300);
    expect(big.length).toBeGreaterThan(said.length);
  });

  it("says something about an empty oldString rather than guessing", () => {
    expect(whyNotFound(file, "   ")).toContain("empty or only whitespace");
  });
});
