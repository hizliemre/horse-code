import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot } from "../engine/session-scope.js";
import { writeAtomic } from "../session/atomic.js";

/**
 * The rule files another tool used, after their content has been taken into project memory.
 *
 * Migration reads a `CLAUDE.md`, an `AGENTS.md`, a `.cursorrules` and distils what they say into memory
 * entries that every role already carries. The files themselves stay on disk — the user may still run those
 * tools — and that is exactly the problem: they are now a SECOND copy of the project's rules, one that no
 * longer moves when the first one does. An agent that reads one is reading the rules as they were on the day
 * of the migration, and believing them over the memory it was given.
 *
 * Nothing prevented that. It simply did not happen by accident, because no code path injects those files —
 * and "does not happen by accident" is not a guarantee when every role has `read_file`.
 *
 * So the migration writes down what it consumed, and the read is answered with where the content went. Not
 * an error: an agent that is told "this file no longer speaks for the project, its rules are in your memory"
 * has been told something it can act on, while a plain refusal invites it to try another way in.
 */

export const MIGRATED_FILE = join(".horsecode", "migrated.json");

export interface MigratedRecord {
  version: 1;
  at: number;
  /** Repo-relative paths whose content was distilled into memory. */
  files: string[];
}

const path = (cwd: string): string => join(stateRoot(cwd), MIGRATED_FILE);

export async function recordMigrated(cwd: string, files: string[], now = Date.now()): Promise<void> {
  const existing = await loadMigrated(cwd);
  const merged = [...new Set([...(existing?.files ?? []), ...files])].sort();
  if (!merged.length) return;
  const p = path(cwd);
  await mkdir(dirname(p), { recursive: true });
  await writeAtomic(p, `${JSON.stringify({ version: 1, at: now, files: merged } satisfies MigratedRecord, null, 2)}\n`);
}

export async function loadMigrated(cwd: string): Promise<MigratedRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path(cwd), "utf8")) as MigratedRecord;
    return raw?.version === 1 && Array.isArray(raw.files) ? raw : undefined;
  } catch { return undefined; }
}

/** Synchronous, because the tool path that needs it must not await on every read. */
export function loadMigratedSync(cwd: string, readSync: (p: string) => string): MigratedRecord | undefined {
  try {
    const raw = JSON.parse(readSync(path(cwd))) as MigratedRecord;
    return raw?.version === 1 && Array.isArray(raw.files) ? raw : undefined;
  } catch { return undefined; }
}

/** Path comparison that survives `./x`, `x` and a leading slash — an agent writes all three. */
export function isMigrated(rec: MigratedRecord | undefined, file: string): boolean {
  if (!rec?.files.length) return false;
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const target = norm(file);
  return rec.files.some((f) => {
    const m = norm(f);
    // `CLAUDE.md` at the root also answers for a read of `./CLAUDE.md` or an absolute path ending in it.
    return m === target || target.endsWith(`/${m}`);
  });
}

/** What the reader is told instead of the file's contents. */
export function migratedNotice(file: string, rec: MigratedRecord): string {
  const when = new Date(rec.at).toISOString().slice(0, 10);
  return `\`${file}\` is not this project's source of rules any more. It belonged to another tool, and on `
    + `${when} its content was migrated into this project's memory — which you have already been given, `
    + `above, as standing rules and facts.\n\n`
    + `Reading it would give you the rules AS THEY WERE on that date, and they have moved since. If you need `
    + `a rule, use the memory you already carry. If the user has explicitly asked you to look at this file's `
    + `text — to compare it, or to migrate something that was missed — say so and ask them to confirm.`;
}
