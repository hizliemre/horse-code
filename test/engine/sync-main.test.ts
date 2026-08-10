import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncMainBranch, type SyncDeps } from "../../src/engine/sync-main.js";
import { saveMainBranch } from "../../src/engine/main-branch.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { WorktreeManager, type WorktreeSession } from "../../src/worktree/manager.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";
import { reviewBodies } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let repo = "";
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = ""; });

/**
 * A session whose branch was cut, then lived on, while `main` moved underneath it — the situation a resume
 * finds every time. `sessionFile`/`mainFile` decide whether the two sides collide.
 */
async function divergedSession(opts: { session?: string; main?: string; sameFile?: boolean } = {}): Promise<{
  mgr: WorktreeManager; session: WorktreeSession;
}> {
  repo = await initTmpRepo();
  const mgr = new WorktreeManager({ repoRoot: repo });
  await writeFile(join(repo, "shared.txt"), "orig\n", "utf8");
  await defaultGitRunner(["add", "-A"], repo);
  await defaultGitRunner(["commit", "-m", "seed"], repo);
  const session = await mgr.openSession("main", "job");

  // the session's own work, committed on its branch
  const sfile = opts.sameFile === false ? "session-only.txt" : "shared.txt";
  await writeFile(join(session.baseWorktree, sfile), opts.session ?? "SESSION\n", "utf8");
  await defaultGitRunner(["add", "-A"], session.baseWorktree);
  await defaultGitRunner(["commit", "-m", "session work"], session.baseWorktree);

  // …and what the team landed on main in the meantime
  await writeFile(join(repo, "shared.txt"), opts.main ?? "MAIN\n", "utf8");
  await defaultGitRunner(["add", "-A"], repo);
  await defaultGitRunner(["commit", "-m", "main moved"], repo);

  await saveMainBranch(repo, "main"); // already answered — this test is not about the question
  return { mgr, session };
}

const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];
/** Read THEN write: write_file refuses a blind overwrite, so the resolver must open the file first. */
function writeTurn(path: string, content: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "r", name: "read_file", arguments: JSON.stringify({ path }) } },
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function sdeps(mgr: WorktreeManager, provider = new MockProvider([]), notes: string[] = []): SyncDeps {
  const roles: Record<string, RoleConfig> = {
    operational: { models: ["m"], systemPrompt: "P-operational" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
    rounds: 3,
    askHuman: async () => ({ action: "abandon" }),
    manager: mgr,
    note: (t: string) => { notes.push(t); },
  };
}

const never = async (): Promise<string> => { throw new Error("must not ask"); };

describe("syncMainBranch", () => {
  it("brings main into the session branch before it continues", async () => {
    const { mgr, session } = await divergedSession({ sameFile: false });
    const notes: string[] = [];
    const res = await syncMainBranch(sdeps(mgr, new MockProvider([]), notes), session,
      { git: defaultGitRunner, askUser: never });

    expect(res.status).toBe("synced");
    if (res.status === "synced") expect(res.commits).toBe(1);
    // the point of the whole thing: main's version of the file is now in the worktree being worked in
    expect(await readFile(join(session.baseWorktree, "shared.txt"), "utf8")).toBe("MAIN\n");
    // …and the session's own work is still there
    expect(await readFile(join(session.baseWorktree, "session-only.txt"), "utf8")).toBe("SESSION\n");
    expect(notes.join(" ")).toContain("1 commit(s) brought in");
  });

  it("says nothing and does nothing when the branch already contains main", async () => {
    const { mgr, session } = await divergedSession({ sameFile: false });
    await syncMainBranch(sdeps(mgr), session, { git: defaultGitRunner, askUser: never });
    const notes: string[] = [];
    const res = await syncMainBranch(sdeps(mgr, new MockProvider([]), notes), session,
      { git: defaultGitRunner, askUser: never });
    expect(res.status).toBe("current");
    expect(notes).toEqual([]);
  });

  it("resolves a conflict with the operational agent and commits the merge", async () => {
    const { mgr, session } = await divergedSession(); // both sides wrote shared.txt
    const p = new MockProvider([writeTurn("shared.txt", "BOTH\n"), doneTurn]);
    const notes: string[] = [];
    const res = await syncMainBranch(sdeps(mgr, p, notes), session, { git: defaultGitRunner, askUser: never });

    expect(res.status).toBe("synced");
    expect(await mgr.unmergedFiles(session)).toEqual([]);
    expect(await readFile(join(session.baseWorktree, "shared.txt"), "utf8")).toBe("BOTH\n");
    expect(notes.join(" ")).toContain("conflict(s) resolved");
  });

  it("rolls the sync back and continues on the branch when the conflict will not resolve", async () => {
    const { mgr, session } = await divergedSession();
    // Every round leaves the markers in place — the deterministic gate must not accept this.
    const stuck = "<<<<<<< HEAD\nSESSION\n=======\nMAIN\n>>>>>>>\n";
    const p = new MockProvider([writeTurn("shared.txt", stuck), doneTurn, writeTurn("shared.txt", stuck), doneTurn]);
    const notes: string[] = [];
    const res = await syncMainBranch(sdeps(mgr, p, notes), session, { git: defaultGitRunner, askUser: never });

    expect(res.status).toBe("conflicted");
    expect(await mgr.unmergedFiles(session)).toEqual([]); // aborted → not left mid-merge
    // the session's own work is exactly as it was, which is what makes giving up safe
    expect(await readFile(join(session.baseWorktree, "shared.txt"), "utf8")).toBe("SESSION\n");
    expect(notes.join(" ")).toContain("continues on its own branch");
  });

  it("asks for the main branch when the project has not recorded one, then merges it", async () => {
    const { mgr, session } = await divergedSession({ sameFile: false });
    await rm(join(mgr.projectRoot, ".horsecode", "config.json")); // un-answer the question
    let asked = 0;
    const askUser = async (): Promise<string> => { asked++; return "main"; };
    const res = await syncMainBranch(sdeps(mgr), session, { git: defaultGitRunner, askUser });
    expect(asked).toBe(1);
    expect(res.status).toBe("synced");
  });

  it("skips rather than fails when there is no main branch to sync from", async () => {
    const { mgr, session } = await divergedSession({ sameFile: false });
    await rm(join(mgr.projectRoot, ".horsecode", "config.json"));
    const res = await syncMainBranch(sdeps(mgr), session, { git: defaultGitRunner, askUser: async () => "" });
    expect(res.status).toBe("skipped");
  });

  it("a merge git refuses outright skips the sync instead of ending the resume", async () => {
    const { mgr, session } = await divergedSession({ sameFile: false });
    // An uncommitted change in the way — git declines the merge, and the resume must survive that.
    await writeFile(join(session.baseWorktree, "shared.txt"), "dirty\n", "utf8");
    const notes: string[] = [];
    const res = await syncMainBranch(sdeps(mgr, new MockProvider([]), notes), session,
      { git: defaultGitRunner, askUser: never });
    expect(res.status).toBe("skipped");
    expect(notes.join(" ")).toContain("continuing on the branch as it is");
  });
});
