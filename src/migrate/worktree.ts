import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Taking over work that was started in another tool's worktree.
 *
 * Claude Code keeps its feature worktrees under `.claude/worktrees/<name>`, each a real git worktree on its
 * own branch. Measured on a real project: eight of them, one carrying five commits of finished UI work on
 * `feature/pcw-step-basics`, with the plan it was written against sitting in the same tree.
 *
 * Starting horse-code in that project ignores all of it — a run opens its session from the repo's default
 * branch, so the branch's commits are simply not there, and the work is continued by rewriting it.
 *
 * Adoption is deliberately SMALL: it reads the branch and reports what is on it. Nothing is copied, nothing
 * is deleted, and the other tool's worktree is left exactly where it is — it is a registered git worktree
 * sharing this repository, and removing it would be a destructive fix for a problem that is not there.
 * horse-code's own session branches FROM the adopted branch on the next request, which is what "continue"
 * means here: the history is inherited, not replayed.
 */

/** Where Claude Code puts its worktrees, relative to the repo root. */
export const CLAUDE_WORKTREE_DIR = join(".claude", "worktrees");

export interface AdoptedWorktree {
  name: string;
  path: string;
  branch: string;
  /** Commits this branch has that the base does not — the work being handed over. */
  commits: { sha: string; subject: string }[];
  /**
   * Uncommitted paths.
   *
   * Reported rather than ignored: horse-code's session is cut from the BRANCH, so anything not committed in
   * the other tool's worktree does not come across. Discovering that later, after an agent has rewritten the
   * same file, is the expensive way to find out.
   */
  dirty: string[];
  /**
   * Markdown this branch itself changed — the plan or design notes written FOR this work.
   *
   * Taken from the branch's own diff rather than by scanning the repo: that project holds forty plan
   * documents, thirty-nine of which are about something else entirely.
   */
  docs: string[];
  /** What the comparison was against, so the counts above mean something. */
  base: string;
}

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Worktree names available to adopt — what `/continue-from-claude` offers when the name given does not exist. */
export async function listClaudeWorktrees(git: Git, repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, CLAUDE_WORKTREE_DIR);
  if (!existsSync(dir)) return [];
  /**
   * Compared as REAL paths.
   *
   * `git worktree list` prints resolved paths, so on a machine where the repo sits behind a symlink — every
   * macOS temp directory, for one — a literal prefix test matches nothing and the project looks as if it had
   * no worktrees at all.
   */
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const base = real(dir);
  const r = await git(["worktree", "list", "--porcelain"], repoRoot);
  const names: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = real(line.slice("worktree ".length).trim());
    if (p.startsWith(base + "/") || p.startsWith(base + "\\")) names.push(p.slice(base.length + 1));
  }
  return names.sort();
}

export class AdoptError extends Error {
  constructor(message: string, readonly available: string[] = []) {
    super(message);
  }
}

/**
 * Reads an existing worktree and everything a handover needs to know about it.
 *
 * Registration is checked with git rather than by the directory existing: a leftover directory from a
 * deleted worktree looks identical on disk and would produce a session branched from nothing.
 */
export async function adoptClaudeWorktree(
  git: Git, repoRoot: string, name: string, base: string,
): Promise<AdoptedWorktree> {
  const wanted = name.trim().replace(/^["']|["']$/g, "");
  if (!wanted) throw new AdoptError("Name the worktree to continue from.", await listClaudeWorktrees(git, repoRoot));
  const available = await listClaudeWorktrees(git, repoRoot);
  if (!available.includes(wanted)) {
    throw new AdoptError(`No git worktree named \`${wanted}\` under \`${CLAUDE_WORKTREE_DIR}\`.`, available);
  }
  const path = join(repoRoot, CLAUDE_WORKTREE_DIR, wanted);

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch || branch === "HEAD") {
    // A detached worktree has no branch for a session to be cut from; adopting it would silently pin the
    // session to a commit that nothing moves.
    throw new AdoptError(`\`${wanted}\` is not on a branch (detached HEAD) — nothing to continue from.`, available);
  }

  // `base...branch` (three dots) counts from where they diverged, so unrelated movement on the base is not
  // reported as this branch's work.
  const log = await git(["log", "--format=%h%x00%s", `${base}...${branch}`, "--right-only"], repoRoot);
  const commits = log.code === 0
    ? log.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split("\0");
      return { sha: sha!, subject: rest.join("\0") };
    })
    : [];

  const status = await git(["status", "--porcelain"], path);
  const dirty = status.code === 0
    ? status.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean)
    : [];

  const changed = await git(["diff", "--name-only", `${base}...${branch}`], repoRoot);
  const docs = changed.code === 0
    ? changed.stdout.split("\n").map((l) => l.trim()).filter((f) => /\.md$/i.test(f))
    : [];

  return { name: wanted, path, branch, commits, dirty, docs, base };
}

/** How many of each list the summary shows before it stops — enough to recognise the work, short enough to read. */
const SHOWN = 8;

/** The handover, as the user needs to see it before deciding what to ask for next. */
export function describeAdoption(w: AdoptedWorktree): string {
  const lines = [
    `**Continuing from \`${w.name}\`** — branch \`${w.branch}\`.`,
    "",
    `horse-code will branch its next session FROM this branch, so its ${w.commits.length} commit(s) are ` +
    `inherited rather than rewritten. The worktree at \`${CLAUDE_WORKTREE_DIR}/${w.name}\` is left untouched.`,
  ];
  if (w.commits.length) {
    lines.push("", `**What is on it** (vs \`${w.base}\`):`);
    lines.push(...w.commits.slice(0, SHOWN).map((c) => `- \`${c.sha}\` ${c.subject}`));
    if (w.commits.length > SHOWN) lines.push(`- _…and ${w.commits.length - SHOWN} more_`);
  } else {
    lines.push("", `_No commits of its own against \`${w.base}\` — the branch is even with the base._`);
  }
  if (w.docs.length) {
    lines.push("", `**Notes written for this work:** ${w.docs.slice(0, SHOWN).map((d) => `\`${d}\``).join(", ")}` +
      (w.docs.length > SHOWN ? ` _+${w.docs.length - SHOWN} more_` : ""));
  }
  if (w.dirty.length) {
    // Loud, because the session is cut from the BRANCH: uncommitted work does not come across.
    lines.push("", `⚠️ **${w.dirty.length} uncommitted change(s)** in that worktree — these are NOT inherited, ` +
      `only what is committed on \`${w.branch}\` is: ${w.dirty.slice(0, SHOWN).map((f) => `\`${f}\``).join(", ")}` +
      (w.dirty.length > SHOWN ? ` _+${w.dirty.length - SHOWN} more_` : "") +
      `\n\n_Commit them there first if they should carry over._`);
  }
  lines.push("", `Now tell me what to work on next and it starts from here.`);
  return lines.join("\n");
}
