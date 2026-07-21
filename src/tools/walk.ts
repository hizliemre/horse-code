import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".horsecode"]);

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
