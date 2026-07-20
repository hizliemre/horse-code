import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitRunner } from "../../src/worktree/git.js";

/** Geçici bir git repo başlatır: init -b main + user config + initial commit. Repo yolunu döner. */
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
