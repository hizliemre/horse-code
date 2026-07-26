import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One role's assigned chain: primary first, then its fallbacks. */
export interface RoleChain {
  role: string;
  models: string[];
}

/**
 * Persists role→model chains into the GLOBAL config.
 *
 * `/roles adjust` only ever wrote to the in-memory registry, so a carefully tuned 60-role assignment vanished
 * on exit and every new session fell back to the bootstrap heuristic — meaning the LLM tuner's reasoning had to
 * be paid for again and again.
 *
 * The global config is also where the apiKey lives, so this is written defensively:
 *  - the file is READ and PARSED first; an unparseable config aborts the write rather than replacing it
 *    (overwriting it would destroy the key),
 *  - only each role's `models` is touched — an existing `systemPrompt`/`skills` on that role survives,
 *  - every other top-level field is carried through untouched,
 *  - the write is atomic (temp file + rename), so an interrupted write cannot truncate the config.
 *
 * Returns the number of roles written, or 0 when the write was skipped/failed — it is best-effort by design:
 * failing to persist an assignment must never break the session that just made it.
 */
export async function saveRoleChains(home: string, chains: RoleChain[]): Promise<number> {
  const usable = chains.filter((c) => c.role && c.models.length);
  if (!usable.length) return 0;
  const path = join(home, ".horsecode", "config.json");

  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim()) {
      const parsed: unknown = JSON.parse(raw);
      // A config that is not an object is not something we understand well enough to rewrite safely.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
      current = parsed as Record<string, unknown>;
    }
  } catch (e) {
    // ENOENT is fine (first run — there is no key to lose). A PARSE error is not: rewriting a config we
    // could not read would silently drop whatever it held, including the apiKey.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return 0;
  }

  const existingRoles = (typeof current.roles === "object" && current.roles !== null && !Array.isArray(current.roles)
    ? current.roles
    : {}) as Record<string, Record<string, unknown>>;
  const roles: Record<string, Record<string, unknown>> = { ...existingRoles };
  for (const { role, models } of usable) {
    const prev = typeof roles[role] === "object" && roles[role] !== null ? roles[role] : {};
    roles[role] = { ...prev, models: [...models] }; // only the chain changes; a custom prompt stays
  }

  const next = { ...current, roles };
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, path); // atomic: readers see either the old file or the new one, never a half-written one
    return usable.length;
  } catch {
    return 0;
  }
}
