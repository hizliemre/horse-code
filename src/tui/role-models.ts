// Role-aware model filtering for the /roles setmodel picker: reasoning/authoring roles are steered toward
// strong models, the refiner toward a fast/cheap one. Heuristic — matches on the model id.

// Weak/fast model markers (flash, mini, haiku, small parameter counts, …). Everything else is "strong".
const WEAK_RE = /(flash|mini|nano|haiku|lite|small|turbo|fast|\b\d{1,2}b\b)/i;

// Roles that should run on a capable model (spec/plan authoring, judging, the interactive coach).
const STRONG_ROLES = new Set(["analyst", "planner", "coach", "judge", "senior-coder", "senior-designer"]);

const ROLE_ADVICE: Record<string, string> = {
  analyst: "Analyst authors the spec and constitution — use a strong model.",
  planner: "Planner designs the implementation — use a strong model.",
  coach: "The coach is your main assistant — a strong model is recommended.",
  judge: "The judge reviews specs/plans — a strong model gives better critique.",
  "senior-coder": "Senior reviewer — a strong model catches more.",
  "senior-designer": "Senior reviewer — a strong model catches more.",
  refiner: "The refiner only classifies intent and rewrites the prompt — a fast, cheap model is ideal.",
};

export interface RoleModelFilter {
  models: string[];
  note?: string;
}

/**
 * Filters the model list for a role. Strong roles hide weak/fast models; the refiner hides strong ones.
 * Never strands the user: if a filter would empty the list, it falls back to all models (with a note).
 */
export function filterModelsForRole(role: string, all: string[]): RoleModelFilter {
  const advice = ROLE_ADVICE[role];

  if (STRONG_ROLES.has(role)) {
    const strong = all.filter((m) => !WEAK_RE.test(m));
    if (strong.length === 0) return { models: all, note: advice ? `${advice} (No strong models detected — showing all.)` : undefined };
    return { models: strong, note: `${advice ?? ""} Showing ${strong.length} of ${all.length} models (fast/weak models hidden for this role).`.trim() };
  }

  if (role === "refiner") {
    const fast = all.filter((m) => WEAK_RE.test(m));
    if (fast.length === 0) return { models: all, note: advice };
    return { models: fast, note: `${advice ?? ""} Showing ${fast.length} of ${all.length} fast/cheap models.`.trim() };
  }

  return { models: all }; // no preference for other roles → show everything
}

/** Rough capability score from the model id (higher = more capable). Used to auto-pick per role. */
export function capabilityScore(model: string): number {
  const s = model.toLowerCase();
  if (WEAK_RE.test(s)) return 30; // fast/small variants first (gpt-5-mini, claude-haiku, deepseek-flash…)
  if (/opus/.test(s)) return 100;
  if (/gpt-5|\bo3\b|o1-pro/.test(s)) return 92;
  if (/sonnet/.test(s)) return 85;
  if (/gpt-4|gemini.*pro|deepseek/.test(s)) return 75;
  return 60; // unknown → assume mid
}

/**
 * Auto-assigns a fitting model to each role: strong roles get the most capable model available; the rest
 * get the best fast/cheap model (falling back to the most capable if no fast model exists).
 */
export function adjustRoleModels(roles: string[], models: string[]): { role: string; model: string }[] {
  if (models.length === 0) return [];
  const best = [...models].sort((a, b) => capabilityScore(b) - capabilityScore(a))[0];
  const fast = models.filter((m) => WEAK_RE.test(m)).sort((a, b) => capabilityScore(b) - capabilityScore(a))[0] ?? best;
  return roles.map((role) => ({ role, model: STRONG_ROLES.has(role) ? best : fast }));
}
