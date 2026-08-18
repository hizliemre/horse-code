import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { truncateSafe } from "../core/surrogates.js";

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

/**
 * Subcommands with no writing form at all.
 *
 * `ls-remote` is the odd one and belongs here: it reaches the network but writes nothing at all — not the
 * working tree, not a ref, not the object store. It is how a role answers "has the remote moved?" without
 * changing anything. Reported live: a coach asked to sync the branch had to say "git fetch is not supported
 * by this read-only tool, so I cannot see the real synchronisation state" and then reasoned from the last
 * known local state instead.
 */
const READ_ONLY = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "whatchanged",
  "rev-parse", "rev-list", "merge-base", "name-rev", "describe", "symbolic-ref",
  "ls-files", "ls-tree", "cat-file", "count-objects", "show-ref", "for-each-ref", "ls-remote",
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
/** A push crosses the network; the local ceiling would fail a large first push on a slow link. */
export const GIT_PUSH_TIMEOUT_MS = 120_000;

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
    // Settled: what this tool carries is a fixed list, so the same arguments are refused the same way for
    // the life of the run. Measured — one correctness-judge asked for the same missing subcommand eight
    // times in a single turn and was handed the same 468-character list of alternatives each time.
    if (why) return { content: why, isError: true, settled: true };

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
      ? `${truncateSafe(out.text, MAX_GIT_OUTPUT)}\n…[truncated — narrow the range or add --stat]`
      : out.text;
    return { content: clipped, isError: out.code !== 0 };
  },
};

/**
 * …and the three that record work, for the role the user talks to.
 *
 * A separate tool rather than three more entries in the allowlist above, because the difference is not which
 * subcommand it is — it is whether the call needs the user's permission. The reading tool is `safe`, so
 * orientation costs nothing and never interrupts; this one is `exec`, so it goes through the permission
 * engine like any other command that changes something.
 *
 * The gap it closes was reported live: `/graph trace` wrote 231 files into the project checkout, the user
 * asked the coach to commit and push them, and the coach — correctly — answered that it had a read-only git
 * tool and no shell, and printed the three commands for the user to run by hand. Producing work in a place
 * nobody can commit from is not a safety property, it is an unfinished job.
 */
const WRITE = new Set(["add", "commit", "push", "fetch"]);

/**
 * A refspec can write LOCAL refs, which is the one thing fetch must not do here.
 *
 * `git fetch origin +refs/heads/*:refs/heads/*` moves local branches without touching the working tree —
 * the branch a session is standing on could be rewritten under it. A bare fetch, or one naming a remote,
 * updates only `refs/remotes/*`, and that is the whole of what "see whether the remote moved" needs.
 */
const REFSPEC = /:/;

/**
 * Rewriting what is already published is the one thing this must not do.
 *
 * Everything else here is recoverable — a bad commit can be amended, a staged file unstaged — but a force
 * push destroys history on a remote that other people have already pulled, and no permission prompt makes
 * that reversible. Refused rather than asked about.
 */
const REFUSED_PUSH = /^(-f|--force|--force-with-lease|--delete|--mirror|--prune)/;

/** Why this write is not allowed, or undefined when it is. */
export function refuseWrite(args: string[]): string | undefined {
  const bad = args.find((a) => REFUSED_ARG.test(a));
  if (bad) {
    return `\`${bad}\` is not allowed: it can write a file, run a program through git's configuration, or `
      + `point git at another repository.`;
  }
  const [sub] = args;
  if (!sub || !WRITE.has(sub)) {
    return `\`git ${sub ?? ""}\` is not available here — this tool records work (${[...WRITE].join(", ")}). `
      + `Use the \`git\` tool to read history and state.`;
  }
  if (sub === "fetch") {
    const spec = args.slice(1).find((a) => REFSPEC.test(a) && !a.startsWith("-"));
    if (spec) {
      return `\`${spec}\` is not allowed: a refspec can move LOCAL branches, including the one this session `
        + `is standing on. Fetch without one — it updates the remote-tracking refs, which is what tells you `
        + `whether the remote has moved.`;
    }
    const pruned = args.find((a) => /^(--prune|-p)$/.test(a));
    if (pruned) {
      return `\`${pruned}\` is not allowed: it deletes remote-tracking refs, and something else may be `
        + `relying on one. Fetch without it.`;
    }
  }
  const forced = sub === "push" && args.find((a) => REFUSED_PUSH.test(a));
  if (forced) {
    return `\`${forced}\` is not allowed: it rewrites or removes history on the remote, which no one can undo `
      + `from here. Push the branch as it stands, or ask the user to do the rewrite themselves.`;
  }
  return undefined;
}

export const gitWriteTool: Tool = {
  name: "git_write",
  description:
    "Changes git state: `add`, `commit`, `push` and `fetch`, nothing else. `fetch` updates the "
    + "remote-tracking refs so you can see whether the remote has moved — it touches no local branch and no "
    + "file; refspecs and `--prune` are refused. To merge what you fetched, ask the user. Pass arguments as "
    + "a list without the "
    + "leading `git`: [\"add\",\"docs/architecture\"], [\"commit\",\"-m\",\"docs: refresh traces\"], [\"push\"]. "
    + "Use it ONLY when the user has asked for the work to be recorded — committing on your own initiative "
    + "puts a change in their history that they did not ask for. Every call goes through the permission "
    + "prompt, so do the job in as few calls as it takes, and say what you are about to commit BEFORE you "
    + "call it. Read the state first with the `git` tool — which branch you are on, what is staged, what "
    + "changed — and never commit what you have not looked at. Force pushes and history rewrites are "
    + "refused.",
  permissionLevel: "exec",
  parameters: params,
  describe: (args) => {
    const list = (args as { args?: unknown }).args;
    const text = Array.isArray(list) ? list.join(" ") : "";
    // Keyed on the subcommand, so "always allow" can be granted to `git commit` without also granting `git push`.
    const sub = Array.isArray(list) && typeof list[0] === "string" ? list[0] : "";
    return { allowKey: `git ${sub}`, preview: `git ${text}`.slice(0, 200) };
  },
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: `git_write: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
    }
    const args = parsed.data.args;
    const why = refuseWrite(args);
    if (why) return { content: why, isError: true, settled: true };

    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      const child = execFile("git", args, {
        cwd: ctx.cwd,
        // A push talks to a server: the read tool's 30s is a reasonable ceiling for a local query and a
        // pessimistic one for a repository with anything in it.
        timeout: args[0] === "push" ? GIT_PUSH_TIMEOUT_MS : GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT * 4,
        // GIT_TERMINAL_PROMPT=0: a push that needs credentials fails with a message instead of blocking on a
        // prompt no one can see — the TUI owns the terminal, so the agent would simply hang.
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, text: `${stdout}${stderr}`.trim() });
      });
      ctx.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });

    if (!out.text) return { content: out.code === 0 ? "(done)" : "git failed with no output.", isError: out.code !== 0 };
    const clipped = out.text.length > MAX_GIT_OUTPUT
      ? `${truncateSafe(out.text, MAX_GIT_OUTPUT)}\n…[truncated]`
      : out.text;
    return { content: clipped, isError: out.code !== 0 };
  },
};
