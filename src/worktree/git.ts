import { spawn } from "node:child_process";

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Runs git via child_process; never throws, returns {stdout, stderr, code}. */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("git", args, { cwd });
    } catch (e) {
      resolve({ stdout, stderr: e instanceof Error ? e.message : String(e), code: -1 });
      return;
    }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });

/**
 * Git's global options come BEFORE the verb, and two of them take a separate value.
 *
 * "the first argument that is not a flag" is wrong for `git -c user.email=t@t commit`: the value is not a
 * flag either, so it is read as the verb and the commit goes through. The guard's own test caught that. The
 * `--opt=value` forms are one token and need no help; only these take the next one.
 */
const TAKES_A_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

export function gitVerb(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (!a.startsWith("-")) return a;
    if (TAKES_A_VALUE.has(a)) i++;
  }
  return undefined;
}
