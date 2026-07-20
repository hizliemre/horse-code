import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../../src/tools/write.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-write-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("write_file", () => {
  it("üst dizinleri oluşturarak dosya yazar", async () => {
    const res = await writeFileTool.run({ path: "src/yeni.ts", content: "export const x = 1;" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "src/yeni.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("describe onay için allowKey + preview üretir", () => {
    const d = writeFileTool.describe!({ path: "src/a.ts", content: "abc" });
    expect(d.allowKey).toBe("src/a.ts");
    expect(d.preview).toContain("src/a.ts");
    expect(d.preview).toContain("3"); // byte sayısı
  });

  it("geçersiz args'ta throw etmez, isError:true döner", async () => {
    const res1 = await writeFileTool.run({ path: "a.ts" }, ctx());
    expect(res1.isError).toBe(true);
    expect(res1.content).toMatch(/geçersiz|invalid/i);

    const res2 = await writeFileTool.run({}, ctx());
    expect(res2.isError).toBe(true);
    expect(res2.content).toMatch(/geçersiz|invalid/i);
  });
});
