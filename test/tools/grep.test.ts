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
