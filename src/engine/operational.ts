import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { TaskCycleDeps } from "./task-types.js";

export const CommitSchema = z.object({
  message: z.string().describe("A Conventional Commits message: `type(scope): subject`, English, imperative."),
});

const MAX_DIFF = 12_000; // cap the diff handed to the model — a summary is enough for a commit message

/** The operational agent turns a git diff into a single Conventional Commits message. */
export async function runOperational(deps: TaskCycleDeps, diff: string, context: string): Promise<string> {
  const clipped = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff;
  const resolved = deps.roleRegistry.resolve("operational");
  const out = await runStructuredRole({
    provider: deps.provider,
    ...resolved,
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: `Context: ${context}\n\nGit diff of the work just completed:\n\n${clipped}\n\nWrite the commit message.` }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
  }, CommitSchema);
  return out.message.trim();
}

/**
 * Auto-commit a SINGLE file the agent just wrote/edited, with an operational message derived from that file's
 * diff. Used for per-write commits — called sequentially (git isn't parallel-safe) after each write tool.
 */
export async function commitFile(
  deps: TaskCycleDeps, workdir: string, path: string, git: GitRunner = defaultGitRunner,
): Promise<string | undefined> {
  await git(["add", "--", path], workdir);
  const staged = await git(["diff", "--cached", "--quiet", "--", path], workdir);
  if (staged.code === 0) return undefined; // this file didn't actually change
  const diff = await git(["diff", "--cached", "--", path], workdir);
  let message: string;
  try {
    message = await runOperational(deps, diff.stdout, `wrote ${path}`);
  } catch {
    message = `chore: update ${path}`; // operational agent failed → deterministic fallback
  }
  const res = await git(["commit", "-m", message, "--", path], workdir);
  if (res.code !== 0) return undefined;
  deps.note?.(`🔖 ${message}`); // persistent chat-flow note so the user sees each auto-commit
  return message;
}

/**
 * Auto-commit the current state of a git worktree with an operational (Conventional Commits) message.
 * No-op when there's nothing to commit. Returns the message committed, or undefined if nothing changed.
 * Git failures are swallowed (a commit hiccup must never crash the pipeline) but surfaced via onActivity.
 */
export async function commitStep(
  deps: TaskCycleDeps, workdir: string, context: string, git: GitRunner = defaultGitRunner,
): Promise<string | undefined> {
  await git(["add", "-A"], workdir);
  const staged = await git(["diff", "--cached", "--quiet"], workdir);
  if (staged.code === 0) return undefined; // nothing staged → nothing to commit
  const diff = await git(["diff", "--cached"], workdir);
  let message: string;
  try {
    message = await runOperational(deps, diff.stdout, context);
  } catch {
    message = `chore: ${context}`; // operational agent failed → deterministic fallback, still commit the work
  }
  const res = await git(["commit", "-m", message], workdir);
  if (res.code !== 0) return undefined; // commit failed (e.g. hooks) → don't claim success
  deps.note?.(`🔖 ${message}`); // persistent chat-flow note so the user sees each auto-commit
  return message;
}
