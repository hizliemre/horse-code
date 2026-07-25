import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, MAX_READ_CHARS } from "../../src/tools/read.js";

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

// An uncapped read is the most expensive thing an agent can do: the whole file enters the conversation and is
// re-sent on every later turn. One review lens was observed spending 1.9M prompt tokens to produce 21k.
describe("read_file — size cap and paging", () => {
  const big = (lines: number, width = 100) => Array.from({ length: lines }, (_, i) => `${i + 1}`.padEnd(width, "x")).join("\n");

  it("truncates a file past the cap and says so", async () => {
    await writeFile(join(dir, "big.txt"), big(2000), "utf8"); // ~200k chars
    const res = await readFileTool.run({ path: "big.txt" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThan(MAX_READ_CHARS + 500); // cap + footer
    expect(res.content).toContain("read_file: lines 1-");
    expect(res.content).toContain("of 2000");
  });

  // Without this an agent cannot tell a short file from a truncated one, and reasons about content it never saw.
  it("the footer tells the agent exactly how to get the rest", async () => {
    await writeFile(join(dir, "big.txt"), big(2000), "utf8");
    const res = await readFileTool.run({ path: "big.txt" }, ctx());
    const m = res.content.match(/"offset":(\d+)/);
    expect(m).not.toBeNull();
    const next = await readFileTool.run({ path: "big.txt", offset: Number(m![1]) }, ctx());
    expect(next.isError).toBe(false);
    expect(next.content.startsWith(`${m![1]}`)).toBe(true); // continues exactly where the first read stopped
  });

  it("offset + limit return that window, and only that window", async () => {
    await writeFile(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5", "utf8");
    const res = await readFileTool.run({ path: "a.txt", offset: 2, limit: 2 }, ctx());
    expect(res.content).toContain("l2\nl3");
    expect(res.content).not.toContain("l4");
    expect(res.content).toContain("lines 2-3 of 5");
  });

  it("an offset past the end is an error, not silent emptiness", async () => {
    await writeFile(join(dir, "a.txt"), "l1\nl2", "utf8");
    const res = await readFileTool.run({ path: "a.txt", offset: 99 }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/past the end/);
  });

  it("a file under the cap is still returned byte-for-byte (the common case is unchanged)", async () => {
    const content = "hello\nworld\n";
    await writeFile(join(dir, "s.txt"), content, "utf8");
    expect(await readFileTool.run({ path: "s.txt" }, ctx())).toEqual({ content, isError: false });
  });
});
