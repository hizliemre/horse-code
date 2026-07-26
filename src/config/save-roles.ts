import { patchConfig, objectField } from "./patch.js";

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
 * Only each role's `models` is touched — an existing `systemPrompt`/`skills` on that role survives, so a
 * re-tune never silently drops the skills a user assigned. Everything else is `patchConfig`'s job.
 *
 * Returns the number of roles written, or 0 when the write was skipped/failed.
 */
export async function saveRoleChains(home: string, chains: RoleChain[]): Promise<number> {
  const usable = chains.filter((c) => c.role && c.models.length);
  if (!usable.length) return 0;
  const ok = await patchConfig(home, (current) => {
    const roles = objectField(current, "roles") as Record<string, Record<string, unknown>>;
    for (const { role, models } of usable) {
      const prev = typeof roles[role] === "object" && roles[role] !== null ? roles[role] : {};
      roles[role] = { ...prev, models: [...models] }; // only the chain changes; a custom prompt or skills stay
    }
    return { ...current, roles };
  });
  return ok ? usable.length : 0;
}
