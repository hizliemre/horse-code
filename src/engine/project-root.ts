import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * The project a working directory belongs to.
 *
 * Agents do not run in the project. They run in a task worktree under `.horsecode/worktrees/<job>/tasks/…`,
 * and anything looked up relative to their own directory is therefore looked up in the wrong place. Measured
 * twice today: the code graph loaded 55081 nodes at the project root and NOTHING in a worktree, and the
 * constitution was re-established from scratch in every session because the check for an existing one only
 * ever saw the session's own worktree.
 *
 * The rule is structural rather than heuristic where it can be: everything horse-code creates lives under
 * `.horsecode/`, so a path containing `.horsecode/worktrees/` names its own project in its prefix. Only when
 * that is absent does this fall back to walking up for a marker.
 */
export const HC_DIR = ".horsecode";
const WORKTREES = join(HC_DIR, "worktrees");

/** How far up to look before giving up — a caller outside any project walks a few levels, not the disk. */
const MAX_UP = 12;

export function projectRoot(cwd: string): string {
  const abs = resolve(cwd);
  // A horse-code worktree carries its project in its own path; no filesystem probing needed.
  const marker = `${sep}${WORKTREES}${sep}`;
  const at = abs.indexOf(marker);
  if (at > 0) return abs.slice(0, at);
  // Otherwise: the nearest ancestor that looks like a project. `.horsecode` first — it is ours and exact —
  // then a git root, which is what a project is when horse-code has not written anything yet.
  for (const mark of [HC_DIR, ".git"]) {
    let dir = abs;
    for (let i = 0; i < MAX_UP; i++) {
      if (existsSync(join(dir, mark))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return abs; // nothing above it is a project → the caller's own directory is as good as it gets
}
