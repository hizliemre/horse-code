import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReviewNotes, REVIEW_NOTES_FILE } from "../../src/engine/review-notes.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-notes-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("appendReviewNotes", () => {
  it("creates the file with a header on first write, then appends across stages", async () => {
    expect(appendReviewNotes(dir, ["[spec][medium] scope: x"])).toBe(true);
    expect(appendReviewNotes(dir, ["[plan][low] simplicity: y"])).toBe(true);
    const text = await readFile(join(dir, REVIEW_NOTES_FILE), "utf8");
    expect(text).toMatch(/# Deferred review notes/);
    expect(text).toContain("- [spec][medium] scope: x");
    expect(text).toContain("- [plan][low] simplicity: y");
  });

  it("writes nothing for an empty list and never throws on a bad path", () => {
    expect(appendReviewNotes(dir, [])).toBe(false);
    expect(existsSync(join(dir, REVIEW_NOTES_FILE))).toBe(false);
    expect(appendReviewNotes(join(dir, "does", "not", "exist"), ["x"])).toBe(false); // best-effort, no throw
  });
});
