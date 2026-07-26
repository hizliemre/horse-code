import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The one safe way to modify the user's global config.
 *
 * That file holds the apiKey, so every writer must obey the same rules, and having three writers each
 * re-implement them is how one of them eventually gets it wrong:
 *  - the file is READ and PARSED first; an unparseable config aborts the write rather than replacing it,
 *    because overwriting a file we could not read would silently destroy whatever it held,
 *  - the mutation is a patch over the parsed object — every field it does not touch is carried through,
 *  - the write is atomic (temp file + rename), so an interrupted write cannot truncate the config.
 *
 * Best-effort by design: it returns whether the write happened, and failing to persist must never break the
 * session that just made the change.
 */
export async function patchConfig(
  home: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<boolean> {
  const path = join(home, ".horsecode", "config.json");

  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim()) {
      const parsed: unknown = JSON.parse(raw);
      // A config that is not an object is not something we understand well enough to rewrite safely.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      current = parsed as Record<string, unknown>;
    }
  } catch (e) {
    // ENOENT is fine — first run, there is no key to lose. A PARSE error is not.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const next = mutate(current);
  if (!next) return false; // the mutation decided there was nothing to do

  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, path); // readers see either the old file or the new one, never a half-written one
    return true;
  } catch {
    return false;
  }
}

/** Reads a top-level object field, tolerating a config where it is missing or the wrong shape. */
export function objectField(current: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = current[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** Reads a top-level array field, tolerating a config where it is missing or the wrong shape. */
export function arrayField(current: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(current[key]) ? [...(current[key] as unknown[])] : [];
}
