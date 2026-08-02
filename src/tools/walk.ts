import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Directories no search should walk into.
 *
 * `graphify-out` is the newest entry and the one that cost something. It holds the code graph — which agents
 * reach through `graph_find` / `graph_overview` / `graph_trace`, never by reading the JSON — plus a dated
 * BACKUP of the previous graph on every rebuild. Measured on a real project: a coach globbed the repository,
 * found `graphify-out/2026-08-02/graph.json` (250 MB, 325,242 mentions of a directory the user had since
 * deleted), and reasoned from it — concluding a live worktree was an abandoned backup.
 *
 * A stale snapshot of the whole repository, readable as if it were the repository, is worse than no graph at
 * all: it is confidently wrong about paths that no longer exist, and it is enormous.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".horsecode", "graphify-out"]);

/**
 * A directory that is its own checkout is not part of this one.
 *
 * Another tool's worktrees sit inside the repository, and each is a FULL copy of it. Measured on a real
 * project with three of them: a search for `*.csproj` returned 158 files where the project has 41. Every
 * glob and grep came back four times over, and a coach spent its whole turn budget working out which copy
 * was real — its own narration said so four separate times ("that glob matched the whole repo", "grep is
 * mixing all the worktrees") before the run died at `maximum turn count exceeded (50)`.
 *
 * A nested `.git` is the exact signal, and it costs one stat per directory to ask — against walking entire
 * duplicate trees, which is what it prevents.
 */
const isNestedCheckout = (dir: string): boolean => existsSync(join(dir, ".git"));

/** Yields absolute paths of files under root; SKIP_DIRS and nested checkouts are skipped. */
export async function* walkFiles(root: string): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable directory → skip silently
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const dir = join(root, e.name);
      if (isNestedCheckout(dir)) continue; // another checkout of this repository — see above
      yield* walkFiles(dir);
    } else if (e.isFile()) {
      yield join(root, e.name);
    }
  }
}
