import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { PRAdapter } from "../../src/worktree/manager.js";
import { initTmpRepo } from "./helpers.js";

let repo: string | undefined;
let bare: string | undefined;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  if (bare) await rm(bare, { recursive: true, force: true });
  repo = bare = undefined;
});

describe("WorktreeManager push", () => {
  it("base branch'i remote'a push eder", async () => {
    repo = await initTmpRepo();
    bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
    await defaultGitRunner(["remote", "add", "origin", bare], repo);
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    await wm.push(s);
    const r = await defaultGitRunner(["rev-parse", "--verify", `refs/heads/${s.baseBranch}`], bare);
    expect(r.code).toBe(0); // bare remote'ta branch var
  });
});

describe("WorktreeManager openPR", () => {
  it("adaptörü doğru argümanlarla çağırır ve url döner", async () => {
    repo = await initTmpRepo();
    const wm = new WorktreeManager({ repoRoot: repo });
    const s = await wm.openSession("main", "job");
    let captured: unknown;
    const adapter: PRAdapter = {
      createPR: async (input) => {
        captured = input;
        return { url: "https://pr/1", number: 1 };
      },
    };
    const res = await wm.openPR(s, adapter, { base: "main", title: "T", body: "B" });
    expect(res).toEqual({ url: "https://pr/1" });
    expect(captured).toEqual({ branch: "hc/job/base", base: "main", title: "T", body: "B" });
  });
});
