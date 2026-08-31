import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { truncateSafe } from "../core/surrogates.js";
import { gitVerb } from "../worktree/git.js";

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
  /**
   * `git grep` searches tracked content and has no writing form at all — the same standing as `log`.
   *
   * Left out, it was refused twice in one 36-minute run while agents fell back to `find | xargs grep`
   * through the shell, which is slower on a repository this size and searches build output and
   * `node_modules` unless every caller remembers to prune them. git already knows what is tracked.
   */
  "grep",
  /**
   * `check-ignore` asks whether a path is ignored — it reads `.gitignore` and answers, and changes nothing.
   *
   * Left out, it was the one read-only verb agents had to reach for `shell` to run: four calls in one run,
   * each landing outside the tool that knows this repository's rules. And through `shell` its exit code is
   * raw, so "no, that path is not ignored" — which git says with 1 — came back as a failed command.
   */
  "check-ignore",
]);

/**
 * …and the read-only FORM of a subcommand that also writes.
 *
 * Matched on the first two words together, so `worktree list` is allowed while `worktree add` never reaches
 * the allowlist at all.
 */
const READ_ONLY_PAIRS = new Set([
  "worktree list",
  "tag --list", "tag -l", "stash list", "remote -v", "remote show", "config --get", "config --list",
  /**
   * The long forms of what is already allowed, and the queries that only ask.
   *
   * `branch -a` was allowed and `branch --all` was not — the same command spelled the way git's own
   * documentation spells it. Measured in one run: an agent asked for `branch --all` and then `branch
   * --show-current`, and paid a refused turn for each while `-a` sat in this list. A short flag admitted and
   * its long twin refused is not a security boundary, it is a typo in one.
   *
   * These are the closure of what this set already permits, not new ground: every one of them prints
   * information about branches or tags and none of them can create, move or delete a ref. The forms that
   * write — `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `--delete`, `--move`, `--copy`, `--set-upstream-to`,
   * `--edit-description` — are still absent, and a first argument that is not a flag never reaches here.
   */
  "tag --contains", "tag --no-contains", "tag --merged", "tag --points-at", "tag -n",
  "remote --verbose", "remote get-url", "stash show",
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

/**
 * Queries where git uses exit code 1 as an ANSWER rather than as a failure.
 *
 * `git diff --exit-code` returns 1 to say "there ARE differences"; `merge-base --is-ancestor` returns 1 to
 * say "no it is not"; plain `merge-base` returns 1 when the commits share no base. Reporting those as
 * failures tells an agent its question could not be answered while handing it the answer.
 *
 * Measured live: a project-manager asked twice in ten seconds and both replies were marked errors, each
 * carrying the diff it had asked for. The same shape as prettier's exit 1 — a working tool saying "yes".
 *
 * 128 and above are never answers: those are git's own faults (bad object, not a repository).
 */
const ANSWERS_WITH_ONE = new Set([
  "diff", "diff-index", "diff-tree", "diff-files", "merge-base", "check-ignore",
  /**
   * `grep` says "no match" with exit 1, exactly as the others say their own no.
   *
   * Admitted to the read-only set earlier tonight and left out of this one, so a search that found nothing
   * came back as `git failed with no output.` — a fault where there was an answer. Measured live within
   * minutes: `git grep -n -i ExportReportService.cs` twice, both reported as failures, for a file that
   * simply is not in the repository.
   */
  "grep",
]);

export function answeredWithOne(args: string[], code: number): boolean {
  return code === 1 && ANSWERS_WITH_ONE.has(args[0] ?? "");
}

/**
 * How to ask for less — of THIS subcommand, not of the one the advice was written for.
 *
 * `--stat` belongs to `git diff` and to nothing else, and it was appended to every truncated result.
 * Measured live: a lens ran `git ls-files -- *.slnx src toucan docs`, got 60,124 characters back, and was
 * told to try `--stat` — a flag `ls-files` does not have. A remedy the model cannot use is worse than
 * silence, because it will spend a turn discovering that.
 *
 * The earlier fix here was to say WHERE the flag goes, after a lens appended it past the paths and git
 * answered `fatal: option '--stat' must come before non-option arguments`. That was right and is kept —
 * for the one subcommand it is true of.
 */
export function howToNarrow(args: string[]): string {
  const verb = gitVerb(args) ?? "";
  if (verb === "diff" || verb === "show") {
    return "narrow the range, or put `--stat` directly after the subcommand (git " + verb
      + " --stat <rest>), which git requires";
  }
  if (verb === "log") return "ask for fewer commits (-n 20) or just their subjects (--oneline)";
  if (verb === "ls-files" || verb === "ls-tree") return "narrow the pathspec to one directory at a time";
  if (verb === "blame") return "limit it to a range of lines (-L 40,120)";
  return "ask for a narrower part of it";
}

/** What exit 1 MEANS for this query, for the case where git printed nothing at all (`--quiet`). */
export function answerOfOne(args: string[]): string {
  const verb = args[0] ?? "";
  if (verb === "check-ignore") {
    return "No — that path is not ignored by this repository's rules. (git exit code 1, which is the answer here.)";
  }
  if (verb === "grep") {
    return "No match — nothing in the tracked files matches that pattern. (git exit code 1, which is the answer here.)";
  }
  if (verb === "merge-base") {
    return args.includes("--is-ancestor")
      ? "No — the first commit is not an ancestor of the second. (git exit code 1, which is the answer here.)"
      : "No merge base: these commits share no common ancestor. (git exit code 1, which is the answer here.)";
  }
  return "There ARE differences — the comparison is not empty. Nothing failed; `--quiet`/`--exit-code` "
    + "reports this as exit code 1. Re-run without it to see them.";
}

/** Why this invocation is not allowed, or undefined when it is. */
/**
 * A whole pathspec section packed into ONE argument, which git reads as one nonsensical revision.
 *
 * Measured live: `["log","-8","--oneline","--all","-- src/domain/Definitions/ChannelType.cs src/infra…"]`.
 * git answers `fatal: unrecognized argument: -- src/... src/...`, which is true and tells the model
 * nothing about the shape it got wrong — so it sent the same shape four more times, across two agents.
 *
 * Matched tightly: `-- ` with a space is unambiguously a separator that should have been its own element.
 * `--grep=two words` and `--author=A B` are legitimate and do not match, because the space is not directly
 * after the dashes.
 */
const PACKED_PATHSPEC = /^--\s+\S/;

/**
 * …and the same mistake with the space left out: `--toucan/libs/beempa` instead of `--`, `toucan/…`.
 *
 * Read as a long option, so git answers `unrecognized argument` and says nothing about the shape. A long
 * flag that carries a path always spells it with `=` (`--git-dir=/x`, `--src-prefix=a/`), so `--` followed
 * by something holding a slash and no `=` is the separator glued to its first path, not an option.
 */
const GLUED_PATHSPEC = /^--[^\s=]*\/[^\s=]*$/;

/** Query flags on `git branch` that consume the next argument, so its value is not a branch name. */
const BRANCH_TAKES_VALUE = new Set([
  "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort",
  "--color", "--abbrev", "-u", "--set-upstream-to", "-t", "--track",
]);

/** Flags that make `git branch` change a ref rather than list them. */
const BRANCH_WRITERS = new Set([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
  "--edit-description", "--set-upstream", "--set-upstream-to", "--unset-upstream", "-u",
  "-t", "--track", "--no-track", "-f", "--force",
]);

export function branchWrites(rest: string[]): string | undefined {
  /**
   * `--list` says the bare words that follow are PATTERNS, not names.
   *
   * Caught by its own test: the message above recommends `git branch --list <pattern>`, and this guard
   * refused it — the pattern read as a positional argument, which is how a branch is created. Recommending
   * a command the tool then rejects is worse than refusing plainly.
   *
   * Read as a flag ANYWHERE in the arguments rather than by stepping over the next token: `--list` does not
   * consume its argument the way `--contains` does, and skipping blindly would step over a `-d` in
   * `git branch --list -d x` and let a deletion through.
   */
  const listing = rest.some((a) => a === "--list" || a === "-l");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--") return "`git branch` with a pathspec is not a thing this tool needs to run.";
    if (a.startsWith("--")) {
      const name = a.split("=")[0] as string;
      if (BRANCH_WRITERS.has(name)) return `\`git branch ${name}\` changes a branch. Only listing is allowed.`;
      if (BRANCH_TAKES_VALUE.has(name) && !a.includes("=")) i++;   // its value is not a branch name
      continue;
    }
    if (a.startsWith("-")) {
      // Short flags combine: `-avv` is `-a -v -v`. Each letter is checked on its own.
      const bad = [...a.slice(1)].find((c) => BRANCH_WRITERS.has(`-${c}`));
      if (bad) return `\`git branch -${bad}\` changes a branch. Only listing is allowed.`;
      if (BRANCH_TAKES_VALUE.has(a)) i++;
      continue;
    }
    /**
     * A glob is a search, not a name — say how to run the search.
     *
     * Measured live: `git branch *30-Aug-2026-SUNDAY_01*`. Refusing it is right (git would try to create a
     * ref by that literal name), but the agent wanted to FIND branches and was told only what it may not
     * do. `--list` takes exactly this pattern, so the remedy is one word away and worth naming.
     */
    if (listing) continue;   // a bare word here is a pattern for --list, not a new branch's name
    if (/[*?\[]/.test(a)) {
      return `\`git branch ${a}\` would create a branch with that literal name. To search for branches, `
        + `put the pattern after --list: \`git branch --list ${a}\`.`;
    }
    return `\`git branch ${a}\` creates a branch. Only listing is allowed — git_write owns the rest.`;
  }
  return undefined;
}

export function refuse(args: string[]): string | undefined {
  const packed = args.find((a) => PACKED_PATHSPEC.test(a) || GLUED_PATHSPEC.test(a));
  if (packed !== undefined) {
    const parts = packed.slice(2).trim().split(/\s+/).filter(Boolean);
    /**
     * Lead with the RULE about `--`, not with "this holds several".
     *
     * The first version of this message said "each argument must be its own element — this one holds
     * several". Measured live, one turn later: the agent resent `["--  src/a.cs"]` — it had dropped the
     * SECOND path and kept the packing. It read "holds several" as a complaint about the count and fixed
     * the count, which is the symptom; the fault is that `--` is a separator and was welded to a path.
     *
     * So the sentence now names `--` first and shows the exact before and after. A remedy the model
     * misreads costs the same turn as no remedy at all.
     */
    return "`--` is the separator and must be its own element of the list — it is never part of a path. "
      + `You sent ${JSON.stringify([packed]).slice(0, 90)}; send `
      + `${JSON.stringify(["--", ...parts]).slice(0, 130)} instead `
      + "(however many paths follow, they are separate elements too).";
  }
  const bad = args.find((a) => REFUSED_ARG.test(a));
  if (bad) {
    return `\`${bad}\` is not allowed: it can write a file, run a program through git's configuration, or `
      + `point git at another repository.`;
  }
  const [sub, second] = args;
  if (!sub || sub.startsWith("-")) return "The first argument must be a git subcommand, e.g. `status`.";
  if (READ_ONLY.has(sub)) return undefined;
  /**
   * Two subcommands whose read form is the DEFAULT and whose writing forms are named.
   *
   * A pair list cannot express either: `reflog -5` and `config core.ignorecase` both read, and neither has
   * a fixed second word to match on. Written as rules rather than as more entries, because the entries
   * would be endless — every count, every config key.
   *
   * Stated the safe way round: only the named writing forms are refused, and `config` needs its key alone.
   * `git config a.b value` sets it, so a third argument is a write however innocent the key looks.
   */
  /**
   * `branch` is enumerated by what WRITES, because what reads is combinatorial.
   *
   * The pair list above grew twice in one evening — `--all`, `--show-current`, `--contains`, `-vv` — and
   * then `-avv` arrived, which is `-a` and `-vv` in one token. There is no end to that: `-av`, `-rv`,
   * `-vvr`, every ordering. The file's own warning was right about flag lists and I was extending the wrong
   * one: the readers are open-ended, the writers are five verbs git has not added to in years.
   *
   * So for this subcommand the rule is inverted, and only here. Anything that deletes, renames, copies,
   * re-points or creates is refused; everything else lists. Creating is the one that has no flag — a bare
   * name IS the command — so bare words are refused too, after stepping over the values that query flags
   * legitimately take.
   */
  if (sub === "branch") return branchWrites(args.slice(1));
  if (sub === "reflog") {
    return second === "expire" || second === "delete"
      ? `\`git reflog ${second}\` rewrites the reflog. Only reading it is allowed.` : undefined;
  }
  if (sub === "config") {
    if (second !== undefined && !second.startsWith("-") && args.length === 2) return undefined;
    if (args.length > 2 && !args.some((a) => a.startsWith("--get") || a === "--list")) {
      return "`git config <key> <value>` writes configuration. Read one with `git config <key>`.";
    }
  }
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
        // The REAL code, not a boolean: 1 is an answer for some of these queries, 128 never is.
        resolve({ code: (err as { code?: number } | null)?.code ?? (err ? 1 : 0), text });
      });
      ctx.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });

    const failed = out.code !== 0 && !answeredWithOne(args, out.code);
    if (!out.text) {
      if (!failed && out.code === 1) return { content: answerOfOne(args), isError: false };
      return { content: out.code === 0 ? "(no output)" : "git failed with no output.", isError: failed };
    }
    const clipped = out.text.length > MAX_GIT_OUTPUT
      ? `${truncateSafe(out.text, MAX_GIT_OUTPUT)}\n…[truncated — ${howToNarrow(args)}]`
      : out.text;
    return { content: clipped, isError: failed };
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
