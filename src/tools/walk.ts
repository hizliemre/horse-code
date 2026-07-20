import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".horsecode"]);

/** root altındaki dosyaların mutlak yollarını yield eder; SKIP_DIRS atlanır. */
export async function* walkFiles(root: string): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // okunamayan dizin → sessizce atla
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
