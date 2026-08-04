import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool, MAX_GREP_LINE, MAX_GREP_CHARS } from "../../src/tools/grep.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-grep-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const ctx = (): unknown => ({ cwd, signal: new AbortController().signal });

/**
 * A cap on the number of MATCHES is not a cap on the amount of TEXT.
 *
 * A match is a line, and a line has no length limit. Measured on a real project: `graphify-out/graph.json`
 * is a single line of 35,272,070 characters — a file horse-code itself commits — so one match returned
 * thirty-five megabytes. In a live run a brainstormer's prompt reached 3,397,616 characters in one call,
 * after which nothing it did could work.
 */
describe("what a grep result may weigh", () => {
  it("cuts a line that is longer than anyone reads", async () => {
    await writeFile(join(cwd, "bundle.js"), `${"x".repeat(500_000)}NEEDLE${"y".repeat(500_000)}\n`, "utf8");
    const res = await grepTool.run({ pattern: "NEEDLE" }, ctx() as never);
    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThan(MAX_GREP_LINE * 4);
    expect(res.content).toContain("NEEDLE");        // …and the match itself is still shown
    expect(res.content).toMatch(/cut|truncat/i);     // …with the cut stated, not silent
  });

  /** Many medium lines add up to the same problem, so the whole result is bounded too. */
  it("stops when the whole result gets too big, however the size arrives", async () => {
    for (let i = 0; i < 60; i++) {
      await writeFile(join(cwd, `f${i}.ts`), `${"a".repeat(4_000)} NEEDLE\n`, "utf8");
    }
    const res = await grepTool.run({ pattern: "NEEDLE" }, ctx() as never);
    expect(res.content.length).toBeLessThanOrEqual(MAX_GREP_CHARS + 500);
  });

  it("leaves ordinary source completely alone", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export const NEEDLE = 1;\nconst other = 2;\n", "utf8");
    const res = await grepTool.run({ pattern: "NEEDLE" }, ctx() as never);
    expect(res.content).toContain("export const NEEDLE = 1;");
    expect(res.content).not.toMatch(/cut/i);
  });
});
