import { spawn } from "node:child_process";

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** git'i child_process ile çalıştırır; asla throw etmez, {stdout, stderr, code} döner. */
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
