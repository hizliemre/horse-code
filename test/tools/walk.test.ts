import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkFiles } from "../../src/tools/walk.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-walk-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("walkFiles", () => {
  it("dosyaları döner, node_modules/.git'i atlar", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "x", "utf8");
    await writeFile(join(dir, "b.txt"), "y", "utf8");
    await writeFile(join(dir, "node_modules/pkg/index.js"), "z", "utf8");
    await writeFile(join(dir, ".git/config"), "c", "utf8");

    const found: string[] = [];
    for await (const p of walkFiles(dir)) found.push(relative(dir, p));
    expect(found.sort()).toEqual(["b.txt", "src/a.ts"]);
  });
});
