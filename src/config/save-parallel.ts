import { patchConfig } from "./patch.js";

/** Bounds shared by the config schema and `/parallel`, so the command cannot write a value the loader rejects. */
export const MIN_PARALLEL = 1;
export const MAX_PARALLEL = 32;

/**
 * Persists how many tasks may run at once, into the GLOBAL config.
 *
 * It belongs to the machine and its subscriptions, not to one session: the number that is safe here is how
 * many parallel calls YOUR model sources tolerate, and having to rediscover it every time the tool starts is
 * the same defect `/roles adjust` had before it wrote anything down.
 */
export async function saveMaxParallel(home: string, n: number): Promise<boolean> {
  if (!Number.isInteger(n) || n < MIN_PARALLEL || n > MAX_PARALLEL) return false;
  return patchConfig(home, (current) => ({ ...current, maxParallel: n }));
}
