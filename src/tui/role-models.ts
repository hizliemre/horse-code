// Role-aware model selection: the /roles setmodel picker filters models to fit a role, and /roles adjust
// auto-assigns a sensible model to every role (best models → reasoning, coding models → coders, cheap → fast).
// Heuristic — matches on the model id.

// Fast/cheap model markers (flash, mini, haiku, small parameter counts, …). Word-bounded so "mini" doesn't
// match "geMINI" (Gemini is a capable family, not a fast one).
const WEAK_RE = /\b(flash|mini|nano|haiku|lite|small|turbo|fast|\d{1,2}b)\b/i;

// Role tiers. Reasoning roles get the most capable models; coding roles get strong coding models; fast
// roles (classify/route/coordinate) get cheap ones. Order within a tier = priority (first gets the best).
const REASONING_ROLES = ["judge", "analyst", "planner", "coach", "architect"];
const CODING_ROLES = ["senior-coder", "principal-coder", "senior-designer", "coder", "designer", "code-reviewer"];
const FAST_ROLES = ["refiner", "router", "project-manager", "team-lead"];
const CAPABLE_ROLES = new Set([...REASONING_ROLES, ...CODING_ROLES]); // roles that want a non-fast model

const ROLE_ADVICE: Record<string, string> = {
  judge: "The judge critiques specs/plans — use the most capable model (e.g. fable/opus).",
  analyst: "Analyst authors the spec and constitution — use a strong model.",
  planner: "Planner designs the implementation — use a strong model.",
  coach: "The coach is your main assistant — a strong model is recommended.",
  architect: "Architect makes design decisions — use a strong model.",
  "senior-coder": "Senior reviewer — a strong model catches more.",
  "senior-designer": "Senior reviewer — a strong model catches more.",
  "principal-coder": "Principal coder — a strong coding model is recommended.",
  coder: "Coder writes the implementation — a capable coding model helps.",
  designer: "Designer builds the UI — a capable model helps.",
  refiner: "The refiner only classifies intent and rewrites the prompt — a fast, cheap model is ideal.",
  router: "The router only picks a path — a fast, cheap model is ideal.",
};

export interface RoleModelFilter {
  models: string[];
  note?: string;
}

/**
 * Filters the model list for a role. Capable roles hide weak/fast models; fast roles hide strong ones.
 * Never strands the user: if a filter would empty the list, it falls back to all models (with a note).
 */
export function filterModelsForRole(role: string, all: string[]): RoleModelFilter {
  const advice = ROLE_ADVICE[role];

  if (CAPABLE_ROLES.has(role)) {
    const strong = all.filter((m) => !WEAK_RE.test(m));
    if (strong.length === 0) return { models: all, note: advice ? `${advice} (No strong models detected — showing all.)` : undefined };
    return { models: strong, note: `${advice ?? ""} Showing ${strong.length} of ${all.length} models (fast/weak models hidden for this role).`.trim() };
  }

  if (FAST_ROLES.includes(role)) {
    const fast = all.filter((m) => WEAK_RE.test(m));
    if (fast.length === 0) return { models: all, note: advice };
    return { models: fast, note: `${advice ?? ""} Showing ${fast.length} of ${all.length} fast/cheap models.`.trim() };
  }

  return { models: all }; // no preference for other roles → show everything
}

/** Reasoning-effort suffix bump (codex/gpt-5 come as -ultra/-max/-high/-medium/-low). */
const effortBump = (s: string): number =>
  /-(ultra|max|xhigh)/.test(s) ? 4 : /-high/.test(s) ? 3 : /-medium/.test(s) ? 2 : /-low/.test(s) ? 1 : 0;

/** Version bump from a "4-8" / "4.6" style version in the id (opus-4-8 > opus-4-5). */
const versionBump = (s: string): number => {
  const m = s.match(/(\d)[-.](\d)\b/);
  return m ? Number(m[1]) + Number(m[2]) / 10 : 0;
};

/** Capability score from the model id (higher = more capable). Knows the real Claude/OpenAI families. */
export function capabilityScore(model: string): number {
  const s = model.toLowerCase();
  if (WEAK_RE.test(s)) return 20 + effortBump(s); // fast/cheap variants (haiku, flash, gpt-5-mini…)
  if (/fable|mythos/.test(s)) return 100; // Anthropic's most capable
  if (/opus/.test(s)) return 88 + versionBump(s); // opus-4-8 → 92.8 > opus-4-5 → 92.5
  if (/codex|gpt-5|\bo3\b/.test(s)) return 82 + effortBump(s); // strong coding, effort-aware
  if (/sonnet/.test(s)) return 78 + versionBump(s);
  if (/gpt-4|gemini.*pro/.test(s)) return 65;
  if (/deepseek/.test(s)) return 55;
  return 50; // unknown → assume mid
}

/** Collapses a model id to a base identity (drop provider prefixes, effort/variant suffixes, date stamps). */
export function baseModel(model: string): string {
  const segs = model.toLowerCase().split("/");
  let s = segs[segs.length - 1]; // the model name is the last "/"-segment (ids can nest providers: no-think/cc/…)
  s = s.replace(/-(ultra|max|xhigh|high|medium|low|free|thinking|preview)\b/g, "");
  s = s.replace(/-\d{6,8}\b/g, ""); // date stamp
  return s.replace(/-+$/, "");
}

/** Keeps the highest-capability instance of each base model (so cc/opus-4-8 and claude/opus-4-8 don't both count). */
function dedupBest(models: string[]): string[] {
  const best = new Map<string, string>();
  for (const m of models) {
    const key = baseModel(m);
    const cur = best.get(key);
    if (!cur || capabilityScore(m) > capabilityScore(cur)) best.set(key, m);
  }
  return [...best.values()].sort((a, b) => capabilityScore(b) - capabilityScore(a));
}

/**
 * Auto-assigns a sensible model to every role: the reasoning roles (judge first) get the most capable models
 * best-first (judge → fable, analyst → opus-4-8, …); coding roles continue down the capable list (→ codex);
 * fast roles get the cheap models. Duplicate models across providers are collapsed so distinct models are used.
 */
export function adjustRoleModels(roles: string[], models: string[]): { role: string; model: string }[] {
  if (models.length === 0) return [];
  const capable = dedupBest(models.filter((m) => !WEAK_RE.test(m)));
  const fast = dedupBest(models.filter((m) => WEAK_RE.test(m)));
  const capablePool = capable.length ? capable : fast; // no capable models → fall back to fast
  const fastPool = fast.length ? fast : capable; // no fast models → fall back to capable

  const wanted = new Set(roles);
  const known = new Set([...REASONING_ROLES, ...CODING_ROLES, ...FAST_ROLES]);
  // capable-tier roles in priority order (reasoning first, then coding), plus any unknown role.
  const capOrder = [...REASONING_ROLES, ...CODING_ROLES].filter((r) => wanted.has(r))
    .concat(roles.filter((r) => !known.has(r)));
  const fastOrder = FAST_ROLES.filter((r) => wanted.has(r));

  const assign = new Map<string, string>();
  capOrder.forEach((r, i) => assign.set(r, capablePool[i % capablePool.length]));
  fastOrder.forEach((r, i) => assign.set(r, fastPool[i % fastPool.length]));
  return roles.map((role) => ({ role, model: assign.get(role) ?? capablePool[0] }));
}
