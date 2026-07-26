import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileTool } from "../../src/tools/write.js";
import { readFileTool } from "../../src/tools/read.js";
import { shellTool, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../../src/tools/shell.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-guard-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ctx = (readFiles?: Set<string>) =>
  ({ cwd: dir, signal: new AbortController().signal, ...(readFiles ? { readFiles } : {}) });

// Overwriting a file the agent has never looked at destroys content it cannot know about — a sibling task's
// work in a shared worktree, or a file it is about to rewrite from memory.
describe("write_file refuses a blind overwrite", () => {
  it("refuses to overwrite an existing file that was not read", async () => {
    await writeFile(join(dir, "a.ts"), "original", "utf8");
    const res = await writeFileTool.run({ path: "a.ts", content: "replacement" }, ctx(new Set()));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/read_file it first/);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("original"); // untouched
  });

  it("allows it once the file has been read", async () => {
    await writeFile(join(dir, "a.ts"), "original", "utf8");
    const seen = new Set<string>();
    await readFileTool.run({ path: "a.ts" }, ctx(seen));
    const res = await writeFileTool.run({ path: "a.ts", content: "replacement" }, ctx(seen));
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("replacement");
  });

  // Creating something new destroys nothing, so the guard must not stand in the way of ordinary work.
  it("never blocks creating a NEW file", async () => {
    const res = await writeFileTool.run({ path: "new.ts", content: "x" }, ctx(new Set()));
    expect(res.isError).toBe(false);
  });

  it("a successful write counts as knowing the file — a follow-up rewrite is not blind", async () => {
    const seen = new Set<string>();
    await writeFileTool.run({ path: "new.ts", content: "v1" }, ctx(seen));
    const res = await writeFileTool.run({ path: "new.ts", content: "v2" }, ctx(seen));
    expect(res.isError).toBe(false);
  });

  // Auto-approved calls in one turn run in PARALLEL, so a read+write issued together must not race.
  it("a read issued in the same batch counts, even if the write resolves first", async () => {
    await writeFile(join(dir, "a.ts"), "original", "utf8");
    const seen = new Set<string>();
    const read = readFileTool.run({ path: "a.ts" }, ctx(seen));
    const write = writeFileTool.run({ path: "a.ts", content: "replacement" }, ctx(seen));
    const [, w] = await Promise.all([read, write]);
    expect(w.isError).toBe(false);
  });

  it("is inert when no read log is wired (a caller that does not opt in is unaffected)", async () => {
    await writeFile(join(dir, "a.ts"), "original", "utf8");
    expect((await writeFileTool.run({ path: "a.ts", content: "x" }, ctx())).isError).toBe(false);
  });

  it("read_file records the RESOLVED path, so a relative and an absolute reference agree", async () => {
    await writeFile(join(dir, "a.ts"), "original", "utf8");
    const seen = new Set<string>();
    await readFileTool.run({ path: resolve(dir, "a.ts") }, ctx(seen));
    expect((await writeFileTool.run({ path: "a.ts", content: "x" }, ctx(seen))).isError).toBe(false);
  });
});

// There was NO timeout at all: `ng serve`, a stalled install, or any command reading stdin blocked forever.
describe("shell is bounded and non-interactive", () => {
  it("kills a command that outlives its budget and says so", async () => {
    const res = await shellTool.run({ command: "sleep 5", timeout: 200 }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/killed after/);
  }, 10_000);

  it("keeps whatever the command printed before it was killed", async () => {
    const res = await shellTool.run({ command: "echo before-the-hang; sleep 5", timeout: 300 }, ctx());
    expect(res.content).toContain("before-the-hang");
  }, 10_000);

  // A command waiting on input that will never arrive is the classic silent stall.
  it("closes stdin so an input-reading command ends instead of hanging", async () => {
    const res = await shellTool.run({ command: "cat", timeout: 3_000 }, ctx());
    expect(res.content).not.toMatch(/killed after/); // it ended on EOF, not on the timeout
  }, 10_000);

  it("a normal command is unaffected", async () => {
    const res = await shellTool.run({ command: "echo hi" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("hi");
    expect(res.content).toContain("(exit 0)");
  });

  it("the budget is capped — nothing runs unbounded even if asked", () => {
    expect(MAX_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
  });

  it("the description warns against watchers and interactive commands", () => {
    expect(shellTool.description).toMatch(/NON-INTERACTIVELY/);
    expect(shellTool.description).toMatch(/dev servers/);
  });
});
