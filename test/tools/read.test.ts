import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../../src/tools/read.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns the contents of an existing file", async () => {
    await writeFile(join(dir, "a.txt"), "hello", "utf8");
    const res = await readFileTool.run({ path: "a.txt" }, ctx());
    expect(res).toEqual({ content: "hello", isError: false });
  });

  it("returns isError:true for a nonexistent file (does not throw)", async () => {
    const res = await readFileTool.run({ path: "missing.txt" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("read_file");
  });

  it("does not throw on invalid args, returns isError:true", async () => {
    const res1 = await readFileTool.run({}, ctx());
    expect(res1.isError).toBe(true);
    expect(res1.content).toMatch(/invalid/i);

    const res2 = await readFileTool.run({ path: 123 }, ctx());
    expect(res2.isError).toBe(true);
    expect(res2.content).toMatch(/invalid/i);
  });
});
