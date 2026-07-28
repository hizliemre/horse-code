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
/** Enough to read the diff it was given and answer. It has no tools and nothing to explore. */
export const OPERATIONAL_MAX_TURNS = 3;

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
    // One sentence from a diff it was handed. Uncapped, a model that would not call `submit` walked its whole
    // fallback chain at fifty turns an attempt — to phrase a commit message.
    maxTurns: OPERATIONAL_MAX_TURNS,
  }, CommitSchema);
  return out.message.trim();
}

/**
 * Auto-commit a SINGLE file the agent just wrote/edited, with an operational message derived from that file's
 * diff. Used for per-write commits — called sequentially (git isn't parallel-safe) after each write tool.
 */
/**
 * A commit message derived from the path alone — no model call.
 *
 * Every file an implementer wrote used to cost a BLOCKING call to the operational role to phrase its commit,
 * in series, inside the attempt's twenty-minute budget: a task touching fifteen files paid fifteen inline
 * round-trips before it could carry on working. And the message describes the wrong unit anyway — "persist
 * the sort preference" is what the TASK did, not what one of its five files did.
 *
 * So the per-file commits, which exist so a killed attempt keeps its work, are labelled deterministically.
 */
export function fileCommitMessage(path: string): string {
  const p = path.replace(/\\/g, "/");
  const type =
    /(^|\/)(test|tests|spec|__tests__)\//.test(p) || /\.(spec|test)\.[a-z]+$/.test(p) ? "test"
      : /\.(md|mdx|txt|rst)$/i.test(p) ? "docs"
        : /(^|\/)(package\.json|tsconfig[^/]*\.json|angular\.json|vite\.config|.*\.config\.[a-z]+)$/i.test(p) ? "build"
          : "chore";
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")).split("/").filter((x) => x !== "src").pop() : "";
  return `${type}${dir ? `(${dir})` : ""}: update ${p.slice(p.lastIndexOf("/") + 1)}`;
}

export async function commitFile(
  deps: TaskCycleDeps, workdir: string, path: string, git: GitRunner = defaultGitRunner,
): Promise<string | undefined> {
  await git(["add", "--", path], workdir);
  const staged = await git(["diff", "--cached", "--quiet", "--", path], workdir);
  if (staged.code === 0) return undefined; // this file didn't actually change
  const message = fileCommitMessage(path);
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
