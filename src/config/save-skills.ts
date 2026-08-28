import { patchConfig, objectField, arrayField } from "./patch.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { SkillSource } from "../skills/external.js";

/**
 * Records a skill source in the global config so it survives the session and `/skills update` can find it.
 *
 * Merged BY NAME: re-adding a skill re-points it (a new subpath, a different pin) rather than accumulating
 * duplicate entries that would fight over the same cache directory.
 */
export async function saveSkillSource(home: string, src: SkillSource): Promise<boolean> {
  return patchConfig(home, (current) => {
    /**
     * Installing one skill must not silently drop the shipped ones.
     *
     * A config that has never stated a list gets the defaults at load time; writing a list for the first
     * time ends that, so the defaults are written INTO the list here rather than being quietly replaced by
     * the single skill the user happened to install first. Removing one afterwards is then a real act with
     * a real result, which is the point.
     */
    if (current["skillSources"] === undefined) current = { ...current, skillSources: [...DEFAULT_CONFIG.skillSources] };
    const sources = arrayField(current, "skillSources").filter(
      (s) => !(typeof s === "object" && s !== null && (s as { name?: unknown }).name === src.name),
    );
    return { ...current, skillSources: [...sources, src] };
  });
}

/** Removes a skill source. Returns false when it was not configured — the caller reports that, not this. */
export async function removeSkillSource(home: string, name: string): Promise<boolean> {
  let found = false;
  const ok = await patchConfig(home, (current) => {
    const sources = arrayField(current, "skillSources");
    const kept = sources.filter((s) => {
      const match = typeof s === "object" && s !== null && (s as { name?: unknown }).name === name;
      if (match) found = true;
      return !match;
    });
    return found ? { ...current, skillSources: kept } : undefined;
  });
  return ok && found;
}

/**
 * Persists which skills a role uses.
 *
 * An EMPTY list is written explicitly rather than omitted: "this role has no skills" and "this role never said"
 * mean different things — the first is the user's opt-out (a project that writes no unit tests must not have
 * its coding agents inventing a test suite), the second falls back to the defaults.
 */
export async function saveRoleSkills(home: string, assignments: Record<string, string[]>): Promise<number> {
  const names = Object.keys(assignments);
  if (!names.length) return 0;
  const ok = await patchConfig(home, (current) => {
    const roles = objectField(current, "roles") as Record<string, Record<string, unknown>>;
    for (const role of names) {
      const prev = typeof roles[role] === "object" && roles[role] !== null ? roles[role] : {};
      roles[role] = { ...prev, skills: [...assignments[role]] }; // the model chain is untouched
    }
    return { ...current, roles };
  });
  return ok ? names.length : 0;
}

/**
 * Records an MCP server in the global config.
 *
 * Merged by name so re-adding one re-points it rather than accumulating a second entry that would fight the
 * first for the same tool prefix.
 */
export async function saveMcpServer(home: string, name: string, spec: unknown): Promise<boolean> {
  return patchConfig(home, (current) => ({
    ...current,
    mcp: { ...objectField(current, "mcp"), [name]: spec },
  }));
}
