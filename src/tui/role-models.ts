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

/** The source/provider of a model id (segment before the first "/"). */
const providerOf = (model: string): string => model.split("/")[0];

/**
 * Orders models to spread load across sources: each provider's models are sorted best-first, then the
 * providers are interleaved (strongest provider first). Round-robin over this list hands consecutive roles
 * different providers — so no single source (e.g. antigravity) gets every role.
 */
function interleaveByProvider(models: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const p = providerOf(m);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(m);
  }
  for (const list of groups.values()) list.sort((a, b) => capabilityScore(b) - capabilityScore(a));
  const ordered = [...groups.values()].sort((a, b) => capabilityScore(b[0]) - capabilityScore(a[0]));
  const out: string[] = [];
  for (let added = true; added; ) {
    added = false;
    for (const list of ordered) { const m = list.shift(); if (m) { out.push(m); added = true; } }
  }
  return out;
}

/**
 * Auto-assigns a fitting model to each role AND spreads roles across sources. Strong roles round-robin over
 * the capable models (provider-interleaved → each a top model of a different source); the rest round-robin
 * over the fast/cheap models. Falls back to the strong pool when no fast model exists (and vice versa).
 */
export function adjustRoleModels(roles: string[], models: string[]): { role: string; model: string }[] {
  if (models.length === 0) return [];
  const isFast = (m: string): boolean => WEAK_RE.test(m);
  const strong = interleaveByProvider(models.filter((m) => !isFast(m)));
  const fastOnly = models.filter(isFast);
  const fast = interleaveByProvider(fastOnly);
  const strongPool = strong.length ? strong : fast; // no capable models → use the fast ones
  const fastPool = fast.length ? fast : strong; // no fast models → use the capable ones
  let si = 0, fi = 0;
  return roles.map((role) =>
    STRONG_ROLES.has(role)
      ? { role, model: strongPool[si++ % strongPool.length] }
      : { role, model: fastPool[fi++ % fastPool.length] },
  );
}
