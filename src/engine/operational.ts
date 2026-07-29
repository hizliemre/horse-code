import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { TaskCycleDeps } from "./task-types.js";
import { callSignal, SHORT_CALL_MS } from "../agent/deadline.js";

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
    perAttemptMs: SHORT_CALL_MS, // each model in the chain gets its own clock — see RoleAgentOptions
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
  // Marked as a checkpoint, because that is what it is: `squashTask` replaces the lot with one real message
  // when the task lands. Labelling it `feat(x): …` would be a conventional-commit claim nothing checked.
  return `wip(${type}${dir ? `/${dir}` : ""}): ${p.slice(p.lastIndexOf("/") + 1)}`;
}

/**
 * Files an agent made for ITSELF, which must never reach the review.
 *
 * Caught live and it cost a whole task: T057 was rejected twice, both times with the reviewer saying the
 * work was right — "the payload code itself is approved" — and then listing `taskflow-state-type-repro.tmp.ts`,
 * `tsconfig.angular-test-only.tmp.json` and `tsconfig.state-repro.tmp.json` as the reason it could not pass.
 * Every file the implementer writes is committed, so its scratchpad and its deliverable were the same thing.
 * Ten attempts later the task was abandoned with working code in it.
 *
 * Deliberately narrow. These are names no deliverable carries — `.tmp.`, `-repro.`, `.scratch.` — so the
 * rule can be mechanical without guessing at intent. A file that merely LOOKS temporary to a human (a
 * `debug.ts`, a `test2.js`) is left alone: the cost of wrongly dropping real work is far higher than the
 * cost of one more review note.
 */
export const SCRATCH_RE = /(^|\/|\.)(tmp|scratch|repro|sandbox)\.|[-_.](tmp|scratch|repro)\.[a-z]+$/i;

/** True when this path is an agent's own working file rather than part of the change it was asked to make. */
export function isScratch(path: string): boolean {
  return SCRATCH_RE.test(path.split("/").pop() ?? path);
}

export async function commitFile(
  deps: TaskCycleDeps, workdir: string, path: string, git: GitRunner = defaultGitRunner,
): Promise<string | undefined> {
  // An agent's scratchpad stays in the worktree and out of the diff the reviewer judges.
  if (isScratch(path)) return undefined;
  await git(["add", "--", path], workdir);
  const staged = await git(["diff", "--cached", "--quiet", "--", path], workdir);
  if (staged.code === 0) return undefined; // this file didn't actually change
  const message = fileCommitMessage(path);
  const res = await git(["commit", "-m", message, "--", path], workdir);
  if (res.code !== 0) return undefined;
  /**
   * Deliberately silent.
   *
   * These are checkpoints, and `squashTask` replaces the lot with one real message when the task lands.
   * Narrating each of them buried the thing people were actually looking for: a user watching this asked
   * three separate times where the real commits were, while thirty `wip(chore/data): …` lines scrolled past.
   * What is being written live is already on the agent's row ("writing taskflow.store.ts").
   */
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
  // `add -A` sweeps in whatever is lying around, which is exactly how a scratchpad reached a review.
  const dirty = await git(["diff", "--cached", "--name-only"], workdir);
  const scratch = dirty.stdout.split("\n").map((l) => l.trim()).filter((l) => l && isScratch(l));
  if (scratch.length) await git(["reset", "--quiet", "--", ...scratch], workdir);
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

/**
 * Collapses a task's per-file checkpoints into ONE commit that says what the task did.
 *
 * The per-file commits exist so a killed attempt keeps its work — they are scaffolding, not history, and as
 * history they are actively bad: thirty lines of `chore(transport): update local-change-transport.ts` say
 * nothing about what changed or why. Writing a real message for each of them was worse still, because it put
 * a blocking model call after every single write.
 *
 * A task is the unit a commit message describes. So the checkpoints are squashed at the end and one message
 * is written from the WHOLE diff — one model call per task instead of one per file, and a history a person
 * can read.
 */
export async function squashTask(
  deps: TaskCycleDeps, worktree: string, baseRef: string, title: string, git: GitRunner = defaultGitRunner,
): Promise<string | undefined> {
  const fork = await git(["merge-base", "HEAD", baseRef], worktree);
  if (fork.code !== 0) return undefined;
  const at = fork.stdout.trim();
  if (!at) return undefined;
  const aheadOut = await git(["rev-list", "--count", `${at}..HEAD`], worktree);
  const ahead = Number(aheadOut.stdout.trim() || "0");
  if (ahead < 1) return undefined; // nothing of ours to squash
  const diff = await git(["diff", `${at}..HEAD`], worktree);
  if (!diff.stdout.trim()) return undefined;

  let message: string;
  try {
    message = await runOperational(deps, diff.stdout, `completed the task: ${title}`);
  } catch {
    message = `chore: ${title}`; // the operational agent failed → the task's own title, which still says what it was
  }
  // --soft: the working tree and index are untouched, only the branch pointer moves. Nothing can be lost here
  // that `git reflog` would not still hold.
  const reset = await git(["reset", "--soft", at], worktree);
  if (reset.code !== 0) return undefined;
  const res = await git(["commit", "-m", message], worktree);
  if (res.code !== 0) return undefined;
  // The one commit a person wants to see, said so it cannot be mistaken for a checkpoint.
  deps.note?.(`📦 **${message}**${ahead ? ` — ${ahead} checkpoint(s) squashed` : ""}`);
  return message;
}
