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
  it("var olan dosyanın içeriğini döner", async () => {
    await writeFile(join(dir, "a.txt"), "merhaba", "utf8");
    const res = await readFileTool.run({ path: "a.txt" }, ctx());
    expect(res).toEqual({ content: "merhaba", isError: false });
  });

  it("olmayan dosyada isError:true döner (throw etmez)", async () => {
    const res = await readFileTool.run({ path: "yok.txt" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("read_file");
  });
});
