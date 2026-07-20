import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

describe("defaultGitRunner", () => {
  it("başarılı komutta stdout + code 0 döner", async () => {
    repo = await initTmpRepo();
    const r = await defaultGitRunner(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("main");
  });
  it("başarısız komutta nonzero code döner (throw etmez)", async () => {
    repo = await initTmpRepo();
    const r = await defaultGitRunner(["this-is-not-a-git-command"], repo);
    expect(r.code).not.toBe(0);
  });
});
