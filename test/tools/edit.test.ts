import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool } from "../../src/tools/edit.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-edit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("benzersiz eşleşmeyi değiştirir", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "b", newString: "Y" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("a Y a");
  });

  it("çoklu eşleşmede replaceAll olmadan hata döner", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "a", newString: "X" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("benzersiz");
  });

  it("replaceAll ile tüm eşleşmeleri değiştirir", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run(
      { path: "f.txt", oldString: "a", newString: "X", replaceAll: true },
      ctx(),
    );
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("X b X");
  });

  it("eşleşme yoksa hata döner", async () => {
    await writeFile(join(dir, "f.txt"), "abc", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "zzz", newString: "Y" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("bulunamadı");
  });

  it("geçersiz args'ta throw etmez, isError:true döner", async () => {
    const res = await editFileTool.run({ path: "f.txt" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/geçersiz|invalid/i);
  });

  it("cwd dışına edit reddedilir (workdir-guard)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-eg-"));
    try {
      const res = await editFileTool.run({ path: "../escape.txt", oldString: "a", newString: "b" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
