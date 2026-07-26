import { SPEC_TEAM, PLAN_TEAM, CODE_TEAM, DEFAULT_COUNCIL } from "../prompts.js";
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
// The review COUNCIL (5 deciders) casts the binding vote on contested work → genuinely strong (Opus-tier) models.
const COUNCIL_ROLES = DEFAULT_COUNCIL.map((c) => c.name);
// Review finder lenses, by stage. A spec is a small business-level doc → a capable, efficient model suffices;
// plan and code lenses reason over technical design and real implementations → strong models.
const SPEC_LENS_ROLES = SPEC_TEAM.map((c) => c.name);
const PLAN_LENS_ROLES = PLAN_TEAM.map((c) => c.name);
const CODE_LENS_ROLES = CODE_TEAM.map((c) => c.name);
const STRONG_ROLES = [
  "brainstormer", "analyst", "planner", "architect", "senior-coder", "senior-designer",
  ...COUNCIL_ROLES, ...PLAN_LENS_ROLES, ...CODE_LENS_ROLES,
];
const MID_ROLES = ["coach", "coder", "designer", "code-reviewer", "operational", "memory-keeper", ...SPEC_LENS_ROLES];
const FAST_ROLES = ["refiner", "router", "project-manager", "team-lead"];
const CAPABLE_ROLES = new Set([...FLAGSHIP_ROLES, ...STRONG_ROLES, ...MID_ROLES]); // want a non-fast model

// Human-readable role profiles — the picker advice AND the brief the LLM tuner reasons over.
export const ROLE_PROFILES: Record<string, string> = {
  refiner: "Classifies intent and rewrites the prompt every turn — highest call volume, trivial task → a fast, cheap model.",
  router: "Picks coder-vs-designer for a task — tiny and frequent → fast, cheap.",
  "project-manager": "Turns a task list into board items — light and structured → fast, cheap.",
  "team-lead": "Coordinates implementation waves — light orchestration → fast, cheap.",
  coach: "Your main interactive assistant, used constantly all session (highest interaction volume) → a capable but EFFICIENT model, never the costly flagship.",
  brainstormer: "Turns a raw request into a decided design before the spec: explores the repo, weighs 2-3 approaches, gets the user to choose. Low volume, sets the direction for everything downstream → a strong reasoning model.",
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
  "memory-keeper": "Decides what a finished job taught the project and writes it to durable memory — low volume, but a bad memory poisons every later run → a capable, efficient model, never the cheapest.",
  operational: "Handles version control: writes conventional commit messages and (later) drives merges/conflicts — high volume → a capable, efficient model.",
};

// Review-role profiles are DERIVED from the lens definitions so the tuner's brief can never drift from the
// actual lens set: each stage's finders + the council deciders, described with the model heft they deserve.
for (const [stage, lenses, heft] of [
  ["spec", SPEC_TEAM, "a capable, efficient model (a spec is a short business-level doc)"],
  ["plan", PLAN_TEAM, "a strong model (technical design judgment)"],
  ["code", CODE_TEAM, "a strong model (reads real implementations)"],
] as const) {
  for (const l of lenses) ROLE_PROFILES[l.name] = `${stage.toUpperCase()}-review lens — ${l.perspective}. Low volume, quality-critical → ${heft}.`;
}
for (const c of DEFAULT_COUNCIL) {
  ROLE_PROFILES[c.name] = `Review COUNCIL decider — ${c.perspective} Casts the binding pass/revise vote on contested work → a strong model.`;
}

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

/**
 * Version bump read from the id, ANCHORED to the model family: "opus-4-8" → 4.8, "sonnet-4.6" → 4.6, and —
 * critically — a bare major release like "opus-5" → 5.0. Reading a bare major as 0 would rank a brand-new
 * `opus-5` (88.0) BELOW the older `opus-4-8` (92.8), so a new generation would never get picked. Anchoring to
 * the family name also stops a date suffix ("opus-4-5-20251101") from being read as the version.
 */
const versionBump = (s: string, family?: string): number => {
  if (family) {
    const m = s.match(new RegExp(`${family}[-_. ]?(\\d+)(?:[-.](\\d+))?`));
    if (m) {
      const major = Number(m[1]);
      const minor = m[2] === undefined ? 0 : Number(m[2]);
      // A 4-digit "major" is a date (…-20251101), not a version → fall through to the generic scan.
      if (major < 100) return major + (minor < 10 ? minor / 10 : minor / 100);
    }
  }
  const g = s.match(/(\d)[-.](\d)\b/); // generic fallback: ids that put the version before the family name
  return g ? Number(g[1]) + Number(g[2]) / 10 : 0;
};

/**
 * Families we actually recognise as general-purpose LLMs. An omniroute catalog also carries image/video and
 * vanity endpoints (`veo`, `big-pickle`, `pepper-1`, …); those score as "unknown" and must never be handed a
 * reasoning role just because they happen to sit in a source the round-robin reached.
 */
const KNOWN_FAMILY_RE = /(fable|mythos|opus|sonnet|haiku|claude|codex|gpt-|\bo\d\b|gemini|deepseek|llama|qwen|kimi|glm|mistral|grok|nova|command-r|phi-\d)/i;
/**
 * Endpoints that are not general-purpose TEXT models. They often carry a known family name (…/gemini-3-pro-
 * image-preview, …/gemini-2.5-computer-use-…), so the family regex alone waved them through and they were
 * handed real reasoning roles.
 */
const NON_TEXT_RE = /\b(image|imagen|vision|video|veo|tts|audio|speech|voice|embed|embedding|rerank|ocr|computer-use|realtime|moderation)\b/i;

export function isKnownModel(model: string): boolean {
  return KNOWN_FAMILY_RE.test(model) && !NON_TEXT_RE.test(model);
}

/** Score given to a model we can't rank — used as the floor that keeps it out of the reasoning tiers. */
const UNRANKED_SCORE = 50;

/** Capability score from the model id (higher = more capable). Knows the real Claude/OpenAI families. */
export function capabilityScore(model: string): number {
  const s = model.toLowerCase();
  if (WEAK_RE.test(s)) return 20 + effortBump(s); // fast/cheap variants (haiku, flash, gpt-5-mini…)
  if (/fable|mythos/.test(s)) return 100; // Anthropic's most capable
  if (/opus/.test(s)) return 88 + versionBump(s, "opus"); // opus-5 → 93 > opus-4-8 → 92.8 > opus-4-5 → 92.5
  // The version is a TIEBREAK here, not a tier mover: scaled down so it orders gpt-5.6 above gpt-5.5
  // without disturbing how this family calibrates against opus/sonnet.
  if (/codex|gpt-5|\bo3\b/.test(s)) return 82 + effortBump(s) + versionBump(s, "gpt") / 100; // effort- AND version-aware
  if (/sonnet/.test(s)) return 78 + versionBump(s, "sonnet");
  // Gemini Pro was pinned at a flat 65: every generation scored the same and the -high/-low effort
  // suffix was ignored, so a current Gemini Pro was ranked as if it were the first one. Version- and
  // effort-aware now, like every other family we actually rank.
  // NB: plain /pro/ — ids separate with underscores as well as dashes (tllm/gemini_3_pro), and \bpro\b
  // never matches after an underscore because "_" is a word character.
  if (/gemini/.test(s) && /pro/.test(s)) return 76 + versionBump(s, "gemini") + effortBump(s);
  if (/gpt-4/.test(s)) return 65;
  if (/deepseek/.test(s)) return 55;
  return UNRANKED_SCORE; // recognised family but no ranking signal (llama/qwen/kimi/…) or plain unknown
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
  // Floor: a model we cannot actually rank (score = the unknown default) is NOT "mid" — it must not win a
  // reasoning/review slot over a model we know. It stays usable for cheap roles and as a fallback tail.
  if (s <= UNRANKED_SCORE) return "fast";
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

/**
 * The model FAMILY — the base identity with its version stripped, so `claude-sonnet-5` and `claude-sonnet-4-6`
 * are both `claude-sonnet`. Used to prefer the newest release of a family for PRIMARY assignments.
 */
export function modelFamily(model: string): string {
  return baseModel(model)
    .replace(/[-.]v?\d+(?:[-.]\d+)*(?=[-.]|$)/g, "") // version segments (kept anchored so "o3"/"70b" survive)
    .replace(/[-.]{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Puts the newest release of each family FIRST, its older siblings after — a bias, not a filter.
 *
 * With both `claude-sonnet-5` and `claude-sonnet-4-6` in the catalog, the round-robin that spreads roles over
 * models was handing out the OLD one for half the slots even though the newer sibling was right there. Ordering
 * fixes that without shrinking the pool: dropping older versions outright would starve source diversity (fewer
 * distinct models to spread across) and remove the obvious substitute when the newest is rate-limited.
 */
function latestFirst(models: string[]): string[] {
  const best = new Map<string, string>();
  for (const m of models) {
    const key = modelFamily(m);
    const cur = best.get(key);
    if (!cur || capabilityScore(m) > capabilityScore(cur)) best.set(key, m);
  }
  const isLatest = (m: string): boolean => best.get(modelFamily(m)) === m;
  return [...models.filter(isLatest), ...models.filter((m) => !isLatest(m))];
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

const BAND_ORDER: Record<ReturnType<typeof modelBand>, number> = { fast: 0, mid: 1, strong: 2, flagship: 3 };

/**
 * How far a candidate sits from the primary's heft. A fallback is a SUBSTITUTE, not an upgrade: standing in for
 * a mid model with a flagship one silently multiplies cost and latency, and defeats the tiering that put the
 * role on a mid model in the first place. At equal distance the STRONGER one wins — a fallback still has to be
 * able to do the work, so erring upward is safer than erring down.
 */
function bandDistance(primary: string, candidate: string): number {
  const p = BAND_ORDER[modelBand(primary)];
  const c = BAND_ORDER[modelBand(candidate)];
  return Math.abs(c - p) * 2 + (c < p ? 1 : 0);
}

/**
 * Picks up to `n` fallback models for a primary.
 *
 * A DIFFERENT source still leads — that is what a fallback is for, since the failure it exists to survive is a
 * rate-limited or exhausted subscription, and a same-source fallback would be dead weight against it. Among the
 * cross-source candidates, though, the CLOSEST heft wins rather than the strongest: the pool is ordered
 * best-first, so taking the first match used to jump a whole band (a mid primary falling onto an Opus-tier
 * fallback) even when an exact peer sat further down the same list.
 */
function pickFallbacks(primary: string, pool: string[], n: number): string[] {
  const chosen: string[] = [];
  const usedModels = new Set([baseModel(primary)]);
  const usedSources = new Set([sourceOf(primary)]);
  // Stable: equal band distance keeps the pool's own (capability) order.
  const byHeft = pool.map((m, i) => ({ m, i })).sort((a, b) => bandDistance(primary, a.m) - bandDistance(primary, b.m) || a.i - b.i).map((x) => x.m);
  for (const m of byHeft) { // pass 1: distinct source, closest heft
    if (chosen.length >= n) break;
    if (usedModels.has(baseModel(m)) || usedSources.has(sourceOf(m))) continue;
    chosen.push(m); usedModels.add(baseModel(m)); usedSources.add(sourceOf(m));
  }
  for (const m of byHeft) { // pass 2: any distinct model (when there aren't enough sources)
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
  // Unrecognised endpoints (video/vanity models) are kept only as a last resort: they must not win a tier slot
  // over a real LLM just because source round-robin reached their source first.
  const recognised = models.filter(isKnownModel);
  const pick = recognised.length ? recognised : models; // nothing recognised → fall back to whatever exists
  const capable = dedupBest(pick.filter((m) => !WEAK_RE.test(m)));
  const fast = dedupBest(pick.filter((m) => WEAK_RE.test(m)));
  const capablePool = capable.length ? capable : fast; // no capable models → fall back to fast
  const fastPool = fast.length ? fast : capable; // no fast models → fall back to capable
  // PRIMARY assignment leads with the newest release of each family; older siblings stay available behind them
  // (both for the tail of the round-robin and for the FALLBACK chains, where the previous version of a
  // rate-limited model is exactly the substitute you want).
  const primaryPool = latestFirst(capablePool);
  const primaryFast = latestFirst(fastPool);
  const nonFlagship = primaryPool.filter((m) => modelBand(m) !== "flagship");
  const strongPool = primaryPool.filter((m) => modelBand(m) === "strong");
  const midPool = primaryPool.filter((m) => modelBand(m) === "mid");

  const wanted = new Set(roles);
  const known = new Set([...FLAGSHIP_ROLES, ...STRONG_ROLES, ...MID_ROLES, ...FAST_ROLES]);
  const primary = new Map<string, string>();

  // Flagship roles: the most capable models, greedy (judge → fable, principal → next-most-capable).
  const flagSrc = primaryPool; // top of the capable pool is the flagship
  FLAGSHIP_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, flagSrc[i % flagSrc.length]));
  // Strong roles (+ any unknown role): Opus-tier, source-spread so they don't pile on one subscription.
  const strongSrc = interleaveBySource(strongPool.length ? strongPool : nonFlagship.length ? nonFlagship : primaryPool);
  STRONG_ROLES.filter((r) => wanted.has(r)).concat(roles.filter((r) => !known.has(r)))
    .forEach((r, i) => primary.set(r, strongSrc[i % strongSrc.length]));
  // Mid roles: capable-but-NOT-flagship, source-spread (coach/coder must not get the flagship).
  const midSrc = interleaveBySource(midPool.length ? midPool : nonFlagship.length ? nonFlagship : primaryPool);
  MID_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, midSrc[i % midSrc.length]));
  // Fast roles: cheap models, round-robin.
  FAST_ROLES.filter((r) => wanted.has(r)).forEach((r, i) => primary.set(r, primaryFast[i % primaryFast.length]));

  return roles.map((role) => {
    const head = primary.get(role) ?? primaryPool[0];
    // Mid/high-volume roles never fall back onto the flagship either; fast roles lead with cheap models.
    // NB: drawn from capablePool (all versions), not primaryPool — an older sibling is a fine fallback.
    const capForFb = MID_ROLES.includes(role) ? capablePool.filter((m) => modelBand(m) !== "flagship") : capablePool;
    const pool = FAST_ROLES.includes(role) ? [...fastPool, ...capForFb] : [...capForFb, ...fastPool];
    return { role, models: [head, ...pickFallbacks(head, pool, FALLBACK_COUNT)] };
  });
}
