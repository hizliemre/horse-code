import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../../src/tools/grep.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-grep-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("grep", () => {
  it("returns matching lines in path:line:text format", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "const foo = 1;\nconst bar = 2;", "utf8");
    const res = await grepTool.run({ pattern: "foo" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("src/a.ts:1:const foo = 1;");
    expect(res.content).not.toContain("bar");
  });

  it("reports when there are no matches (isError:false)", async () => {
    await writeFile(join(dir, "a.txt"), "nothing", "utf8");
    const res = await grepTool.run({ pattern: "zzz" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("no matches");
  });

  it("returns isError on broken regex", async () => {
    const res = await grepTool.run({ pattern: "(" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("does not throw on invalid args, returns isError:true", async () => {
    const res = await grepTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

/**
 * `flags` means REGEX flags, and a model reaching for grep reaches for grep's command line. Seen in a real
 * run: `flags: "-m 3"` — grep's max-count — handed straight to `new RegExp`, which threw "Invalid flags
 * supplied to RegExp constructor" and cost the turn.
 */
describe("grep tells regex flags from grep's command-line options", () => {
  it("refuses a CLI option instead of failing inside RegExp", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf8");
    const r = await grepTool.run({ pattern: "alpha", flags: "-m 3" }, ctx() as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not a regex flag");
    expect(r.content).not.toContain("RegExp constructor"); // the model gets the distinction, not the stack
  });

  /**
   * Salvaging letters would be worse than failing: "-m 3" contains `m`, a real JS flag, so the call would
   * have silently run in multiline mode and answered a question nobody asked.
   */
  it("does not salvage a valid flag letter out of an invalid string", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\n", "utf8");
    expect((await grepTool.run({ pattern: "alpha", flags: "-m 3" }, ctx() as never)).isError).toBe(true);
  });

  it("still accepts real regex flags", async () => {
    await writeFile(join(dir, "a.ts"), "ALPHA\n", "utf8");
    const r = await grepTool.run({ pattern: "alpha", flags: "i" }, ctx() as never);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("ALPHA");
  });

  it("treats an absent or empty flags value as no flags", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\n", "utf8");
    for (const flags of [undefined, "", "  "]) {
      expect((await grepTool.run({ pattern: "alpha", ...(flags === undefined ? {} : { flags }) }, ctx() as never)).isError).toBeFalsy();
    }
  });
});
