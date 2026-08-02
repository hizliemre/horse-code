import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * Giving a new session the project as it actually is.
 *
 * A session's base worktree is cut from a BRANCH, so it starts with what was committed and nothing else. In
 * practice that is not the project: the work in progress is uncommitted, and the things horse-code itself
 * relies on — the code graph, the memory, the constitution, the installed skills — are frequently not in git
 * at all. Measured on a real project: `.horsecode/` entirely untracked and `graphify-out/` never committed,
 * so every session opened blind and every task inside it opened blinder.
 *
 * The root is a REFERENCE and is never written to: anything a run leaves there is outside the pull request
 * it exists to produce. So the state comes IN at the start, lives in the session, and goes out with the work.
 */

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Project state horse-code depends on that git often does not carry.
 *
 * Named rather than discovered: a blanket copy of everything ignored would drag in `node_modules`, build
 * output and caches — gigabytes per session, and none of it is state the run reasons about.
 */
export const INHERITED_ASSETS: string[] = [
  join("graphify-out", "graph.json"),
  join(".horsecode", "memory.jsonl"),
  join(".horsecode", "skills"),
  join(".specify", "memory", "constitution.md"),
  join(".horsecode", "migrated.json"),
];

/**
 * Never followed, whatever else is true.
 *
 * `.horsecode/worktrees` holds the sessions themselves — copying it into a session would copy that session
 * into itself, and the one after it again.
 */
const NEVER = [join(".horsecode", "worktrees")];

const excluded = (rel: string): boolean =>
  NEVER.some((n) => rel === n || rel.startsWith(n + sep) || rel.startsWith(n + "/"));

/**
 * A directory that is its own checkout is not this project's working state.
 *
 * The named assets above were bounded deliberately — the comment there warns that a blanket copy would drag
 * in gigabytes — and then the UNTRACKED copy was left unbounded, which is the same mistake by the other door.
 * Measured on a real project: `git ls-files --others` reported 26,160 files under `.claude/`, almost all of
 * them inside `worktrees.orphaned-backup/` — abandoned checkouts of the same repository, 29 GB of them. Every
 * session opened copied 22 GB of that before doing any work.
 *
 * A nested `.git` is the signal, and it is exact: whatever lives under it belongs to another checkout, and
 * nothing there is the uncommitted work this function exists to carry across.
 */
function nestedCheckout(repoRoot: string, rel: string, cache: Map<string, boolean>): boolean {
  const parts = rel.split(/[\\/]/).slice(0, -1); // the file's ancestors, nearest last
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    let hit = cache.get(acc);
    if (hit === undefined) { hit = existsSync(join(repoRoot, acc, ".git")); cache.set(acc, hit); }
    if (hit) return true;
  }
  return false;
}

/**
 * A backstop for whatever the `.git` rule does not catch.
 *
 * Bounded by COUNT rather than bytes: the cost that hurt was per-file — 26,160 copies before the session
 * could start — and a count is something the note can state plainly for the user to act on.
 */
export const MAX_UNTRACKED = 5_000;

export interface Inherited {
  /** Uncommitted edits to tracked files that were carried across. */
  modified: string[];
  /** Files present in the project but not in git, carried across. */
  untracked: string[];
  /** Named assets (graph, memory, skills, constitution) that were found and carried across. */
  assets: string[];
  /** Tracked files deleted in the project but still in the branch — the deletion is carried too. */
  deleted: string[];
  /** Untracked files deliberately left behind: another checkout's, or past the count bound. */
  skipped: number;
}

async function copyPath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, dereference: true, force: true });
}

/**
 * Copies the project's working state into a freshly opened session base.
 *
 * Best-effort per entry: one unreadable file must not stop a session from opening, and the alternative —
 * refusing to start — is worse than starting with slightly less context.
 */
export async function inheritFromRoot(git: Git, repoRoot: string, baseWorktree: string): Promise<Inherited> {
  const out: Inherited = { modified: [], untracked: [], assets: [], deleted: [], skipped: 0 };
  if (repoRoot === baseWorktree) return out;

  // Uncommitted edits to tracked files, and tracked files the user has deleted. `HEAD` rather than the base
  // branch: this is "what the project looks like right now" — the same thing the user is staring at.
  const changed = await git(["diff", "--name-status", "HEAD"], repoRoot);
  if (changed.code === 0) {
    for (const line of changed.stdout.split("\n")) {
      const [status, ...rest] = line.trim().split(/\t/);
      const rel = rest.join("\t");
      if (!status || !rel || excluded(rel)) continue;
      try {
        if (status.startsWith("D")) { await rm(join(baseWorktree, rel), { force: true }); out.deleted.push(rel); }
        else { await copyPath(join(repoRoot, rel), join(baseWorktree, rel)); out.modified.push(rel); }
      } catch { /* one file must not stop the session opening */ }
    }
  }

  // Files that exist in the project but not in git — new work that has not been added yet.
  const others = await git(["ls-files", "--others", "--exclude-standard"], repoRoot);
  if (others.code === 0) {
    const nested = new Map<string, boolean>();
    for (const rel of others.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (excluded(rel) || nestedCheckout(repoRoot, rel, nested)) { out.skipped++; continue; }
      if (out.untracked.length >= MAX_UNTRACKED) { out.skipped++; continue; }
      try { await copyPath(join(repoRoot, rel), join(baseWorktree, rel)); out.untracked.push(rel); }
      catch { /* same */ }
    }
  }

  // …and the state git is not carrying at all.
  for (const rel of INHERITED_ASSETS) {
    const from = join(repoRoot, rel);
    if (!existsSync(from)) continue;
    try {
      await stat(from);
      await copyPath(from, join(baseWorktree, rel));
      out.assets.push(rel);
    } catch { /* same */ }
  }
  return out;
}

/** One line for the user: what the session started with that the branch alone would not have given it. */
export function describeInherited(i: Inherited): string | undefined {
  const parts: string[] = [];
  const n = i.modified.length + i.deleted.length;
  if (n) parts.push(`${n} uncommitted change(s)`);
  if (i.untracked.length) parts.push(`${i.untracked.length} untracked file(s)`);
  // Stated, not silent: a session that quietly left work behind looks identical to one that had none.
  if (i.skipped) parts.push(`${i.skipped} left behind (another checkout, or past the ${MAX_UNTRACKED} bound)`);
  if (i.assets.length) parts.push(i.assets.map((a) => `\`${a}\``).join(", "));
  return parts.length ? `📥 Carried into this session: ${parts.join(" · ")}.` : undefined;
}


/**
 * Tops a RESUMED session up with the project state it never saw.
 *
 * A session inherits once, when it is opened. A preserved worktree that is picked up days later still holds
 * the project as it was that day — and measured on a real one, that is exactly what went wrong: the session
 * was cut before the constitution existed, the user wrote one in the project, resumed the job, and the run
 * reported "No `.specify/` directory exists yet" and set about writing a second one. The file was thirty-two
 * kilobytes away in the root the whole time.
 *
 * Only what is MISSING, and never an overwrite. The session's copy of any of these may be its own work in
 * progress — a memory it added, a constitution it drafted — and replacing that with the root's version to
 * make it "fresh" would destroy the thing the resume exists to continue.
 */
export async function topUpInherited(repoRoot: string, baseWorktree: string): Promise<string[]> {
  const added: string[] = [];
  if (repoRoot === baseWorktree) return added;
  for (const rel of INHERITED_ASSETS) {
    const from = join(repoRoot, rel);
    const to = join(baseWorktree, rel);
    if (!existsSync(from) || existsSync(to)) continue;
    try { await copyPath(from, to); added.push(rel); } catch { /* one asset must not stop a resume */ }
  }
  return added;
}

/** One line for the user when a resumed session picked something up that it had never seen. */
export function describeTopUp(added: string[]): string | undefined {
  if (!added.length) return undefined;
  return `📥 This session was opened before ${added.map((a) => `\`${a}\``).join(", ")} existed — carried in now.`;
}
