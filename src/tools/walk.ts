import { readdir } from "node:fs/promises";
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

/** Yields absolute paths of files under root; SKIP_DIRS entries are skipped. */
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
      yield* walkFiles(join(root, e.name));
    } else if (e.isFile()) {
      yield join(root, e.name);
    }
  }
}
