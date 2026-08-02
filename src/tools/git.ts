import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types.js";

/**
 * Git, for reading only.
 *
 * A coach asked to review a branch's state had no way to run `git status` and said so: "there is no shell
 * tool in this environment; I'll work with file reads and grep instead" — and then spent its turn budget
 * reconstructing from files what one command answers exactly. Being read-only is the right shape for that
 * role; being unable to ASK git anything was an accident of it.
 *
 * A shell would have solved it and opened everything else. This does not run a shell: the binary is `git`,
 * the arguments are passed as a list, and there is no interpreter to interpret `;`, `&&`, `$(…)` or a
 * redirect. What is left to police is git itself, which is a large program with a small read-only core.
 *
 * The subcommands below are inherently read-only in EVERY form they accept — there is no flag that makes
 * `git log` write. Anything whose safety depends on which flags follow it (`branch -D`, `stash`, `worktree
 * add`, `checkout`) is refused rather than parsed, because a flag allowlist is a thing that gets one entry
 * longer each time someone needs it and is wrong exactly once.
 */

/** Subcommands with no writing form at all. */
const READ_ONLY = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "whatchanged",
  "rev-parse", "rev-list", "merge-base", "name-rev", "describe", "symbolic-ref",
  "ls-files", "ls-tree", "cat-file", "count-objects", "show-ref", "for-each-ref",
]);

/**
 * …and the read-only FORM of a subcommand that also writes.
 *
 * Matched on the first two words together, so `worktree list` is allowed while `worktree add` never reaches
 * the allowlist at all.
 */
const READ_ONLY_PAIRS = new Set([
  "worktree list", "branch --list", "branch -l", "branch -a", "branch -v", "branch -r",
  "tag --list", "tag -l", "stash list", "remote -v", "remote show", "config --get", "config --list",
]);

/**
 * Arguments refused wherever they appear.
 *
 * `--output` turns a diff into a file write. `-c`/`--config-env` inject configuration — `core.pager`,
 * `alias.*` and hooks all run programs. `-C`/`--git-dir`/`--work-tree` point git at a different repository,
 * which makes the cwd this tool is scoped to a suggestion rather than a boundary.
 */
const REFUSED_ARG = /^(--output|-c$|--config-env|--exec-path|-C$|--git-dir|--work-tree|--upload-pack|--receive-pack)/;

const params = z.object({
  args: z.array(z.string()).min(1).describe(
    'Git arguments as a list, without the leading "git" — e.g. ["status","--porcelain"] or ["log","-5","--oneline"].'),
});

export const MAX_GIT_OUTPUT = 60_000;
export const GIT_TIMEOUT_MS = 30_000;

/** Why this invocation is not allowed, or undefined when it is. */
export function refuse(args: string[]): string | undefined {
  const bad = args.find((a) => REFUSED_ARG.test(a));
  if (bad) {
    return `\`${bad}\` is not allowed: it can write a file, run a program through git's configuration, or `
      + `point git at another repository.`;
  }
  const [sub, second] = args;
  if (!sub || sub.startsWith("-")) return "The first argument must be a git subcommand, e.g. `status`.";
  if (READ_ONLY.has(sub)) return undefined;
  if (second && READ_ONLY_PAIRS.has(`${sub} ${second}`)) return undefined;
  return `\`git ${sub}\` is not available here — this tool reads history and state, it never changes them. `
    + `Available: ${[...READ_ONLY].sort().join(", ")}; also ${[...READ_ONLY_PAIRS].sort().join(", ")}.`;
}

export const gitTool: Tool = {
  name: "git",
  description:
    "Runs a READ-ONLY git command in the working directory and returns its output. Pass arguments as a list "
    + "without the leading `git`: [\"status\",\"--porcelain\"], [\"log\",\"-10\",\"--oneline\"], "
    + "[\"diff\",\"--stat\",\"main...HEAD\"], [\"show\",\"abc123:path/to/file\"]. Use it for what only git "
    + "knows — what changed, when, by which commit, how a branch compares to another. Commands that change "
    + "anything (checkout, commit, reset, clean, branch -D, stash, worktree add) are refused.",
  permissionLevel: "safe",
  parameters: params,
  describe: (args) => {
    const list = (args as { args?: unknown }).args;
    const text = Array.isArray(list) ? list.join(" ") : "";
    return { allowKey: "git:read", preview: `git ${text}`.slice(0, 120) };
  },
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: `git: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
    }
    const args = parsed.data.args;
    const why = refuse(args);
    if (why) return { content: why, isError: true };

    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      const child = execFile("git", args, {
        cwd: ctx.cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT * 4,
        // `--no-pager` would still be needed for some subcommands; killing the pager entirely is simpler and
        // leaves nothing waiting for a terminal that does not exist.
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      }, (err, stdout, stderr) => {
        const text = `${stdout}${stderr}`.trim();
        resolve({ code: err ? 1 : 0, text });
      });
      ctx.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });

    if (!out.text) return { content: out.code === 0 ? "(no output)" : "git failed with no output.", isError: out.code !== 0 };
    const clipped = out.text.length > MAX_GIT_OUTPUT
      ? `${out.text.slice(0, MAX_GIT_OUTPUT)}\n…[truncated — narrow the range or add --stat]`
      : out.text;
    return { content: clipped, isError: out.code !== 0 };
  },
};
