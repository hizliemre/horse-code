import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { createMergeConflict } from "./helpers.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

describe("WorktreeManager.unmergedFiles", () => {
  it("çakışık dosyaları listeler; abortMerge sonrası []", async () => {
    const c = await createMergeConflict();
    repo = c.repo;
    expect(await c.mgr.unmergedFiles(c.session)).toEqual(["shared.txt"]);
    await c.mgr.abortMerge(c.session);
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]);
  });
});
