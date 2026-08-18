import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
  it("replaces the unique match", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "b", newString: "Y" }, ctx());
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("a Y a");
  });

  it("returns an error on multiple matches without replaceAll", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "a", newString: "X" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not unique");
  });

  it("replaces all matches with replaceAll", async () => {
    await writeFile(join(dir, "f.txt"), "a b a", "utf8");
    const res = await editFileTool.run(
      { path: "f.txt", oldString: "a", newString: "X", replaceAll: true },
      ctx(),
    );
    expect(res.isError).toBe(false);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("X b X");
  });

  it("returns an error when there is no match", async () => {
    await writeFile(join(dir, "f.txt"), "abc", "utf8");
    const res = await editFileTool.run({ path: "f.txt", oldString: "zzz", newString: "Y" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });

  it("does not throw on invalid args, returns isError:true", async () => {
    const res = await editFileTool.run({ path: "f.txt" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid/i);
  });

  it("rejects edits outside cwd (workdir-guard)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-eg-"));
    try {
      const res = await editFileTool.run({ path: "../escape.txt", oldString: "a", newString: "b" }, { cwd: dir, signal: new AbortController().signal });
      expect(res.isError).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("an EXISTING file outside cwd is protected by the guard (not ENOENT, actually blocked)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-eg-"));
    try {
      const sub = join(root, "sub");
      await mkdir(sub, { recursive: true });
      await writeFile(join(root, "outside.txt"), "orig", "utf8"); // file that exists OUTSIDE cwd (sub)
      const res = await editFileTool.run(
        { path: "../outside.txt", oldString: "orig", newString: "HACKED" },
        { cwd: sub, signal: new AbortController().signal },
      );
      expect(res.isError).toBe(true);
      expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("orig"); // unchanged
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

/**
 * A failure names the file the way this project does, not the way the caller happened to spell it.
 *
 * An agent that writes absolute paths — the planner does — puts 110 characters of
 * `/Users/…/.horsecode/worktrees/17-Aug-2026-MONDAY_01/base/` in front of every diagnosis. The model is
 * charged for it on each failure, and it swamps the excerpt kept in telemetry: 21 edit failures in one run
 * collapsed to 11 distinct log lines, several groups identical only because the shared prefix filled the
 * budget before the message reached anything that differed.
 */
describe("the path a failure names", () => {
  it("shortens a path inside the working directory", async () => {
    const { shortPath } = await import("../../src/tools/edit.js");
    expect(shortPath("/w/base/specs/005/plan.md", "/w/base")).toBe("specs/005/plan.md");
    expect(shortPath("specs/005/plan.md", "/w/base")).toBe("specs/005/plan.md");
  });

  /** Outside the tree it stays as given — shortening it would name a file that is not the one asked for. */
  it("leaves a path elsewhere exactly as it came", async () => {
    const { shortPath } = await import("../../src/tools/edit.js");
    expect(shortPath("/etc/hosts", "/w/base")).toBe("/etc/hosts");
  });

  it("puts the short form in the message an agent actually reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-edit-path-"));
    try {
      await mkdir(join(dir, "specs"), { recursive: true });
      await writeFile(join(dir, "specs/plan.md"), "# Plan\n\nBody.\n");
      const r = await editFileTool.run(
        { path: join(dir, "specs/plan.md"), oldString: "nothing like this", newString: "x" },
        { cwd: dir, signal: new AbortController().signal } as never,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("(specs/plan.md)");
      expect(r.content).not.toContain(dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
