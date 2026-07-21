import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession, TaskWorktree } from "../../src/worktree/manager.js";

/** Starts a temporary git repo: init -b main + user config + initial commit. Returns the repo path. */
export async function initTmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hc-wt-"));
  const g = (args: string[]) => defaultGitRunner(args, dir);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@hc.local"]);
  await g(["config", "user.name", "hc test"]);
  await writeFile(join(dir, "README.md"), "# repo\n", "utf8");
  await g(["add", "-A"]);
  await g(["commit", "-m", "init"]);
  return dir;
}

/** Sets up a real merge conflict: shared.txt in base → from the same base A(AAA) and B(BBB) →
 *  mergeTask(A) merged, mergeTask(B) conflict. Base is left mid-merge; returns task = B. */
export async function createMergeConflict(): Promise<{
  repo: string; mgr: WorktreeManager; session: WorktreeSession; task: TaskWorktree;
}> {
  const repo = await initTmpRepo();
  const mgr = new WorktreeManager({ repoRoot: repo });
  const session = await mgr.openSession("main", "job");
  const g = (args: string[]) => defaultGitRunner(args, session.baseWorktree);
  await writeFile(join(session.baseWorktree, "shared.txt"), "orig\n", "utf8");
  await g(["add", "-A"]);
  await g(["commit", "-m", "seed shared"]);
  const a = await mgr.deriveTask(session, "task a");
  const b = await mgr.deriveTask(session, "task b");
  await writeFile(join(a.worktree, "shared.txt"), "AAA\n", "utf8");
  await mgr.commitTask(a, "a");
  await writeFile(join(b.worktree, "shared.txt"), "BBB\n", "utf8");
  await mgr.commitTask(b, "b");
  await mgr.mergeTask(session, a); // merged (base shared=AAA)
  await mgr.mergeTask(session, b); // conflict (base mid-merge)
  return { repo, mgr, session, task: b };
}
