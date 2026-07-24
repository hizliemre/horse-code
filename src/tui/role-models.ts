// Role-aware model selection: the /roles setmodel picker filters models to fit a role, and /roles adjust
// auto-assigns a sensible model to every role (best models → reasoning, coding models → coders, cheap → fast).
// Heuristic — matches on the model id.

// Fast/cheap model markers (flash, mini, haiku, small parameter counts, …). Word-bounded so "mini" doesn't
// match "geMINI" (Gemini is a capable family, not a fast one).
const WEAK_RE = /\b(flash|mini|nano|haiku|lite|small|turbo|fast|\d{1,2}b)\b/i;

// Role tiers, by the model heft each role deserves:
//  flagship — highest-stakes, low-volume judgment: the most capable (and costly) model is worth it.
//  strong   — serious reasoning / senior review: an Opus-tier model, but not the flagship.
//  mid      — high-volume or interactive work: a capable, efficient model (Sonnet-tier); NEVER the flagship,
//             which would be wasteful (and slow) at that volume.
//  fast     — classify/route/coordinate: a cheap, fast model.
const FLAGSHIP_ROLES = ["judge", "principal-coder"];
// The review COUNCIL (5 deciders) casts the binding vote on contested docs → genuinely strong (Opus-tier) models.
const COUNCIL_ROLES = ["correctness-judge", "risk-judge", "completeness-judge", "user-value-judge", "feasibility-judge"];
const STRONG_ROLES = ["analyst", "planner", "architect", "senior-coder", "senior-designer", ...COUNCIL_ROLES];
const MID_ROLES = ["coach", "coder", "designer", "code-reviewer", "operational"];
const FAST_ROLES = ["refiner", "router", "project-manager", "team-lead"];
const CAPABLE_ROLES = new Set([...FLAGSHIP_ROLES, ...STRONG_ROLES, ...MID_ROLES]); // want a non-fast model

// Human-readable role profiles — the picker advice AND the brief the LLM tuner reasons over.
export const ROLE_PROFILES: Record<string, string> = {
  refiner: "Classifies intent and rewrites the prompt every turn — highest call volume, trivial task → a fast, cheap model.",
  router: "Picks coder-vs-designer for a task — tiny and frequent → fast, cheap.",
  "project-manager": "Turns a task list into board items — light and structured → fast, cheap.",
  "team-lead": "Coordinates implementation waves — light orchestration → fast, cheap.",
  coach: "Your main interactive assistant, used constantly all session (highest interaction volume) → a capable but EFFICIENT model, never the costly flagship.",
  analyst: "Authors the spec and constitution → a strong reasoning model (Opus-tier).",
  planner: "Designs the implementation plan → a strong reasoning model (Opus-tier).",
  architect: "Diagnoses stuck tasks and produces recovery plans — serious design work → a strong model.",
  judge: "Critiques specs/plans and makes the final review call — low volume, high stakes → the most capable flagship model.",
  coder: "Writes the bulk of the implementation — very high work volume → a good high-throughput coding model (Sonnet-tier), NOT the flagship (wasteful at this volume).",
  "senior-coder": "Reviews and revises above the coder — must be MORE capable than the coder (Opus-tier).",
  "principal-coder": "Final code decision-maker — low volume, high stakes → the flagship is appropriate.",
  designer: "Builds UI — high volume → a capable coding/design model, not the flagship.",
  "senior-designer": "Senior UI reviewer — more capable than the designer.",
  "code-reviewer": "Reviews diffs — moderate volume → a solid capable model.",
  operational: "Handles version control: writes conventional commit messages and (later) drives merges/conflicts — high volume → a capable, efficient model.",
  // Review council — each critiques the spec/plan from one angle; low volume, quality-critical → strong models.
  security: "Team lens: security holes, auth, input validation — low volume, high stakes → a strong model.",
  architecture: "Team lens: architectural soundness, boundaries — low volume → a strong model.",
  testability: "Team lens: testability, isolation, edge-case coverage — low volume → a strong model.",
  correctness: "Team lens: logical correctness, boundary conditions, invariants → a strong model.",
  performance: "Team lens: complexity, hot paths, scalability → a strong model.",
  "error-handling": "Team lens: failure modes, recovery, partial-failure behavior → a strong model.",
  concurrency: "Team lens: races, deadlocks, atomicity, ordering → a strong model.",
  "data-integrity": "Team lens: data modeling, consistency, migrations, transactions → a strong model.",
  "api-design": "Team lens: interface/contract design, compatibility, ergonomics → a strong model.",
  maintainability: "Team lens: readability, coupling/cohesion, tech-debt → a strong model.",
  simplicity: "Team lens: YAGNI, over-engineering, scope creep → a capable model.",
  completeness: "Team lens: requirement coverage, missing cases, spec gaps → a strong model.",
  observability: "Team lens: logging, metrics, tracing, debuggability → a capable model.",
  dependencies: "Team lens: third-party deps, supply-chain, versioning, licensing → a capable model.",
  accessibility: "Team lens: a11y, i18n, inclusive UX → a capable model.",
  // Review COUNCIL — the small decision panel that VOTES on contested docs (weighing the team's findings).
  // Binding, high-stakes → genuinely strong (Opus-tier) models.
  "correctness-judge": "Council decider: votes pass/revise weighing correctness/logic/data findings → a strong model.",
  "risk-judge": "Council decider: votes pass/revise weighing security, failure-mode, and blast-radius findings → a strong model.",
  "completeness-judge": "Council decider: votes pass/revise weighing requirement-coverage and spec-gap findings → a strong model.",
  "user-value-judge": "Council decider: votes pass/revise weighing usability, a11y, and scope-vs-intent → a strong model.",
  "feasibility-judge": "Council decider: votes pass/revise weighing architecture, simplicity, and maintainability → a strong model.",
};
const ROLE_ADVICE = ROLE_PROFILES; // picker note reuses the profiles

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

/** The most capable model in a list (used to pick who does the LLM role-tuning reasoning). */
export function mostCapable(models: string[]): string {
  return [...models].sort((a, b) => capabilityScore(b) - capabilityScore(a))[0] ?? "";
}

/** Which heft band a model sits in — drives which tier of role it's assigned to. */
export function modelBand(model: string): "flagship" | "strong" | "mid" | "fast" {
  if (WEAK_RE.test(model)) return "fast";
  const s = capabilityScore(model);
  if (s >= 95) return "flagship"; // fable / mythos
  if (s >= 84) return "strong"; // opus, codex ultra/high
  return "mid"; // sonnet, gpt-mid, gemini-pro, deepseek
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
 * Auto-assigns a fallback CHAIN (primary + {@link FALLBACK_COUNT} fallbacks) to every role, by tier:
 *  - flagship roles (judge, principal-coder) → the most capable model (judge → fable);
 *  - strong roles (analyst, planner, architect, senior-*) → Opus-tier, source-spread;
 *  - mid roles (coach, coder, designer, code-reviewer) → capable-but-NOT-flagship, source-spread — so the
 *    heavy-volume/interactive roles never burn the costly flagship, and neither do their fallbacks;
 *  - fast roles → cheap models.
 * Fallbacks prefer a different source so an exhausted source drops cleanly. This is the deterministic
 * backstop; {@link ROLE_PROFILES} lets the LLM tuner refine it with reasoning.
 */
export function adjustRoleModels(roles: string[], models: string[]): { role: string; models: string[] }[] {
  if (models.length === 0) return [];
  const capable = dedupBest(models.filter((m) => !WEAK_RE.test(m)));
  const fast = dedupBest(models.filter((m) => WEAK_RE.test(m)));
  const capablePool = capable.length ? capable : fast; // no capable models → fall back to fast
  const fastPool = fast.length ? fast : capable; // no fast models → fall back to capable
  const nonFlagship = capablePool.filter((m) => modelBand(m) !== "flagship");
  const strongPool = capablePool.filter((m) => modelBand(m) === "strong");
  const midPool = capablePool.filter((m) => modelBand(m) === "mid");

  const wanted = new Set(roles);
  const known = new Set([...FLAGSHIP_ROLES, ...STRONG_ROLES, ...MID_ROLES, ...FAST_ROLES]);
  const primary = new Map<string, string>();

  // Flagship roles: the most capable models, greedy (judge → fable, principal → next-most-capable).
  const flagSrc = capablePool; // top of the capable pool is the flagship
  FLAGSHIP_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, flagSrc[i % flagSrc.length]));
  // Strong roles (+ any unknown role): Opus-tier, source-spread so they don't pile on one subscription.
  const strongSrc = interleaveBySource(strongPool.length ? strongPool : nonFlagship.length ? nonFlagship : capablePool);
  STRONG_ROLES.filter((r) => wanted.has(r)).concat(roles.filter((r) => !known.has(r)))
    .forEach((r, i) => primary.set(r, strongSrc[i % strongSrc.length]));
  // Mid roles: capable-but-NOT-flagship, source-spread (coach/coder must not get the flagship).
  const midSrc = interleaveBySource(midPool.length ? midPool : nonFlagship.length ? nonFlagship : capablePool);
  MID_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, midSrc[i % midSrc.length]));
  // Fast roles: cheap models, round-robin.
  FAST_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, fastPool[i % fastPool.length]));

  return roles.map((role) => {
    const head = primary.get(role) ?? capablePool[0];
    // Mid/high-volume roles never fall back onto the flagship either; fast roles lead with cheap models.
    const capForFb = MID_ROLES.includes(role) ? nonFlagship : capablePool;
    const pool = FAST_ROLES.includes(role) ? [...fastPool, ...capForFb] : [...capForFb, ...fastPool];
    return { role, models: [head, ...pickFallbacks(head, pool, FALLBACK_COUNT)] };
  });
}
