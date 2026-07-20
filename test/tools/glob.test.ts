import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../../src/tools/glob.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-glob-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("glob", () => {
  it("desene uyan göreli yolları döner", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "", "utf8");
    await writeFile(join(dir, "src/b.js"), "", "utf8");
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("src/a.ts");
    expect(res.content).not.toContain("src/b.js");
  });

  it("eşleşme yoksa bilgilendirir", async () => {
    await writeFile(join(dir, "a.txt"), "", "utf8");
    const res = await globTool.run({ pattern: "**/*.rs" }, ctx());
    expect(res.content).toContain("eşleşme yok");
  });

  it("geçersiz args'ta hata döner, throw etmez", async () => {
    const res = await globTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});
