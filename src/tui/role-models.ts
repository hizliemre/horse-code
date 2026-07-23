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
 * `exclude` drops models already chosen for this role's chain, so the same model can't be picked twice.
 * Never strands the user: if a filter would empty the list, it falls back to all models (with a note).
 */
export function filterModelsForRole(role: string, all: string[], exclude: string[] = []): RoleModelFilter {
  const advice = ROLE_ADVICE[role];
  const excluded = new Set(exclude);
  const avail = all.filter((m) => !excluded.has(m)); // already-picked chain models are off the table

  if (CAPABLE_ROLES.has(role)) {
    const strong = avail.filter((m) => !WEAK_RE.test(m));
    if (strong.length === 0) return { models: avail.length ? avail : all, note: advice ? `${advice} (No strong models detected — showing all.)` : undefined };
    return { models: strong, note: `${advice ?? ""} Showing ${strong.length} of ${avail.length} models (fast/weak models hidden for this role).`.trim() };
  }

  if (FAST_ROLES.includes(role)) {
    const fast = avail.filter((m) => WEAK_RE.test(m));
    if (fast.length === 0) return { models: avail.length ? avail : all, note: advice };
    return { models: fast, note: `${advice ?? ""} Showing ${fast.length} of ${avail.length} fast/cheap models.`.trim() };
  }

  return { models: avail.length ? avail : all }; // no preference for other roles → show everything (minus picked)
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

/** The underlying subscription source of a model (for chain/source diversity). Normalizes cc→claude, cx→codex. */
export function sourceOf(model: string): string {
  const s = model.toLowerCase().replace(/^no-think\//, ""); // no-think/cc/… → its real source is claude
  const p = s.split("/")[0];
  return p === "cc" ? "claude" : p === "cx" ? "codex" : p;
}

/** Round-robins a capability-sorted pool across its sources, so consecutive picks rotate subscriptions. */
function interleaveBySource(pool: string[]): string[] {
  const bySource = new Map<string, string[]>();
  for (const m of pool) {
    const s = sourceOf(m);
    const q = bySource.get(s);
    if (q) q.push(m);
    else bySource.set(s, [m]); // each source's list stays capability-sorted (pool is sorted desc)
  }
  const queues = [...bySource.values()];
  const out: string[] = [];
  for (let more = true; more; ) {
    more = false;
    for (const q of queues) {
      const m = q.shift();
      if (m !== undefined) { out.push(m); more = true; }
    }
  }
  return out;
}

/**
 * Picks up to `n` fallback models for a primary: prefer a DIFFERENT source (so one source's exhaustion doesn't
 * take out the whole chain), then fill with any distinct model. Never repeats a model already in the chain.
 */
function pickFallbacks(primary: string, pool: string[], n: number): string[] {
  const chosen: string[] = [];
  const usedModels = new Set([baseModel(primary)]);
  const usedSources = new Set([sourceOf(primary)]);
  for (const m of pool) { // pass 1: distinct source
    if (chosen.length >= n) break;
    if (usedModels.has(baseModel(m)) || usedSources.has(sourceOf(m))) continue;
    chosen.push(m); usedModels.add(baseModel(m)); usedSources.add(sourceOf(m));
  }
  for (const m of pool) { // pass 2: any distinct model (when there aren't enough sources)
    if (chosen.length >= n) break;
    if (usedModels.has(baseModel(m))) continue;
    chosen.push(m); usedModels.add(baseModel(m));
  }
  return chosen;
}

/** Chain length: every role gets a primary + this many fallbacks (3 models total) when enough exist. */
export const FALLBACK_COUNT = 2;

/**
 * Auto-assigns a fallback CHAIN (primary + {@link FALLBACK_COUNT} fallbacks) to every role. Reasoning roles
 * get the most capable models best-first (judge → fable, analyst → opus-4-8, …); coding roles are spread
 * across subscriptions (source-interleaved over the leftovers, so they don't all pile on one source like
 * codex); fast roles get the cheap models. Fallbacks prefer different sources so an exhausted source drops
 * cleanly to another. Duplicate models across providers are collapsed so distinct models are used.
 */
export function adjustRoleModels(roles: string[], models: string[]): { role: string; models: string[] }[] {
  if (models.length === 0) return [];
  const capable = dedupBest(models.filter((m) => !WEAK_RE.test(m)));
  const fast = dedupBest(models.filter((m) => WEAK_RE.test(m)));
  const capablePool = capable.length ? capable : fast; // no capable models → fall back to fast
  const fastPool = fast.length ? fast : capable; // no fast models → fall back to capable

  const wanted = new Set(roles);
  const known = new Set([...REASONING_ROLES, ...CODING_ROLES, ...FAST_ROLES]);
  const reasoningOrder = REASONING_ROLES.filter((r) => wanted.has(r)).concat(roles.filter((r) => !known.has(r)));
  const codingOrder = CODING_ROLES.filter((r) => wanted.has(r));
  const fastOrder = FAST_ROLES.filter((r) => wanted.has(r));

  const primary = new Map<string, string>();
  const usedCap = new Set<string>();
  // Reasoning roles: capability-greedy — the strongest models, best-first.
  reasoningOrder.forEach((r, i) => { const m = capablePool[i % capablePool.length]; primary.set(r, m); usedCap.add(m); });
  // Coding roles: source-interleaved so they spread across subscriptions rather than all landing on whichever
  // source dominates (e.g. every coder → codex). Models the reasoning tier didn't take come first (fresh), then
  // the rest of the capable pool — so a thin leftover still yields a diverse, non-repeating spread.
  const leftover = capablePool.filter((m) => !usedCap.has(m));
  const spread = interleaveBySource([...new Set([...leftover, ...capablePool])]);
  codingOrder.forEach((r, i) => primary.set(r, spread[i % spread.length]));
  // Fast roles: cheap models, round-robin.
  fastOrder.forEach((r, i) => primary.set(r, fastPool[i % fastPool.length]));

  return roles.map((role) => {
    const head = primary.get(role) ?? capablePool[0];
    // Fallback pool: same tier first, then the other tier — so a chain never runs short of distinct models.
    const pool = fastOrder.includes(role) ? [...fastPool, ...capablePool] : [...capablePool, ...fastPool];
    return { role, models: [head, ...pickFallbacks(head, pool, FALLBACK_COUNT)] };
  });
}
