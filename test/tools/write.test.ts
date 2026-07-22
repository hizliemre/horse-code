import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  it("writes a file, creating parent directories", async () => {
    const res = await writeFileTool.run({ path: "src/new.ts", content: "export const x = 1;" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "src/new.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("describe produces allowKey + preview for approval", () => {
    const d = writeFileTool.describe!({ path: "src/a.ts", content: "abc" });
    expect(d.allowKey).toBe("src/a.ts");
    expect(d.preview).toContain("src/a.ts");
    expect(d.preview).toContain("3"); // byte count
  });

  it("does not throw on invalid args, returns isError:true", async () => {
    const res1 = await writeFileTool.run({ path: "a.ts" }, ctx());
    expect(res1.isError).toBe(true);
    expect(res1.content).toMatch(/invalid/i);

    const res2 = await writeFileTool.run({}, ctx());
    expect(res2.isError).toBe(true);
    expect(res2.content).toMatch(/invalid/i);
  });

  it("rejects writing outside cwd (workdir-guard)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-wg-"));
    try {
      const res = await writeFileTool.run({ path: "../escape.txt", content: "x" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(true);
      expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("writes inside cwd (guard does not block it)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-wg-"));
    try {
      const res = await writeFileTool.run({ path: "alt/ic.txt", content: "y" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(false);
      expect(existsSync(join(dir, "alt", "ic.txt"))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports live activity (path + line count) via ctx.onActivity on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-act-"));
    try {
      const acts: unknown[] = [];
      await writeFileTool.run(
        { path: "a/spec.md", content: "l1\nl2\nl3\n" },
        { cwd: dir, signal: new AbortController().signal, onActivity: (a) => acts.push(a) },
      );
      expect(acts).toEqual([{ tool: "write", target: "a/spec.md", lines: 4, preview: ["l1", "l2", "l3", ""], startLine: 1 }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
