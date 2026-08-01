import type { ChatRequest, Provider } from "../core/types.js";
import { ROLE_PROFILES, adjustRoleModels, modelBand, sourceOf, capabilityScore, mostCapable, isKnownModel, newestPrimary, strongestPrimary, DURABLE_ROLES } from "../tui/role-models.js";

export interface TunedRoles {
  reasoning: string;
  chains: { role: string; models: string[] }[];
  tuner: string; // the model that did the reasoning
}

/** Groups the catalog by source with a heft hint, so the model can reason about cost/capability + diversity. */
function describeCatalog(models: string[]): string {
  const bySource = new Map<string, string[]>();
  for (const m of models) {
    const s = sourceOf(m);
    const q = bySource.get(s);
    if (q) q.push(m);
    else bySource.set(s, [m]);
  }
  const lines: string[] = [];
  for (const [src, ms] of bySource) {
    lines.push(`Source "${src}":`);
    for (const m of [...ms].sort((a, b) => capabilityScore(b) - capabilityScore(a))) lines.push(`  - ${m} [${modelBand(m)}]`);
  }
  return lines.join("\n");
}

/** Pulls the assignments array out of the model's reply — a ```json fence if present, else the last {...} span. */
function parseAssignments(text: string): { role: string; models: string[] }[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { assignments?: unknown };
      const arr = Array.isArray(obj.assignments) ? obj.assignments : Array.isArray(obj) ? obj : undefined;
      if (Array.isArray(arr)) {
        return arr
          .filter((a): a is { role: string; models: string[] } =>
            !!a && typeof (a as { role?: unknown }).role === "string" && Array.isArray((a as { models?: unknown }).models))
          .map((a) => ({ role: a.role, models: a.models.filter((m): m is string => typeof m === "string") }));
      }
    } catch { /* try the next candidate */ }
  }
  return [];
}

/**
 * Share of roles one model may appear in, across ALL chain positions.
 *
 * The tuner satisfies "fallbacks on a different source" per chain and still converges on the SAME model as the
 * last link of nearly every chain — observed: one model was the final fallback of ~40 of 60 roles. Each chain
 * looked diverse; the fleet was not. The moment the other sources rate-limit, every one of those roles lands on
 * a single subscription at once, which is precisely the failure the fallback exists to survive.
 */
export const MAX_MODEL_SHARE = 0.25;

/**
 * Below this many roles the cap is meaningless and actively harmful: with a handful of roles a repeated
 * fallback is normal, and a 25% share would forbid a model from appearing even twice. The problem this solves
 * is a FLEET-scale one ("one model was the last link of 40 of 60 chains").
 */
export const MIN_FLEET_FOR_SPREAD = 8;

/** How often each model appears across every chain. */
function modelUse(chains: { role: string; models: string[] }[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const c of chains) for (const m of c.models) n.set(m, (n.get(m) ?? 0) + 1);
  return n;
}

/**
 * Replaces over-represented models with the least-used alternative that still fits the chain: a different
 * source from the rest of the chain where possible, closest heft second. Only FALLBACK slots are rewritten —
 * a primary is the tuner's actual reasoning about the role and is left alone.
 *
 * Degrades gracefully: with too few models to satisfy the cap, a role keeps what it had rather than being
 * stranded with a short chain.
 */
export function spreadLoad(chains: { role: string; models: string[] }[], models: string[]): { role: string; models: string[] }[] {
  // Replacements come from real, assignable models only — the raw catalog also carries image/video endpoints.
  if (chains.length < MIN_FLEET_FOR_SPREAD) return chains;
  const pool = models.filter(isKnownModel);
  if (!pool.length) return chains;
  const slots = chains.reduce((n, c) => n + c.models.length, 0);
  // A cap below the pigeonhole minimum is unsatisfiable: with few models, SOME model must repeat. Never ask
  // for less than the unavoidable average, or a small fleet would churn without ever reaching the target.
  const cap = Math.max(Math.ceil(chains.length * MAX_MODEL_SHARE), Math.ceil(slots / pool.length));
  const use = modelUse(chains);
  const out = chains.map((c) => ({ role: c.role, models: [...c.models] }));
  for (const chain of out) {
    for (let i = 1; i < chain.models.length; i++) { // i=1: never touch the primary
      const m = chain.models[i];
      if ((use.get(m) ?? 0) <= cap) continue;
      const sources = new Set(chain.models.filter((_, j) => j !== i).map(sourceOf));
      const inChain = new Set(chain.models);
      const candidates = pool
        .filter((x) => !inChain.has(x) && (use.get(x) ?? 0) < cap)
        .sort((a, b) => (use.get(a) ?? 0) - (use.get(b) ?? 0)
          || (sources.has(sourceOf(a)) ? 1 : 0) - (sources.has(sourceOf(b)) ? 1 : 0)
          || Math.abs(capabilityScore(a) - capabilityScore(m)) - Math.abs(capabilityScore(b) - capabilityScore(m)));
      const pick = candidates[0];
      if (!pick) continue; // nothing left that is under the cap → keep what we have rather than strand the role
      use.set(m, (use.get(m) ?? 1) - 1);
      use.set(pick, (use.get(pick) ?? 0) + 1);
      chain.models[i] = pick;
    }
  }
  return out;
}

/** Keeps only real model ids, dedupes, pads each role's chain to 3 from the heuristic (never invents). */
function validateChains(
  assignments: { role: string; models: string[] }[],
  roles: string[],
  models: string[],
  heuristic: { role: string; models: string[] }[],
): { role: string; models: string[] }[] {
  const valid = new Set(models);
  const byRole = new Map(assignments.map((a) => [a.role, a.models]));
  const heuMap = new Map(heuristic.map((h) => [h.role, h.models]));
  const built = roles.map((role) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    const add = (m: string) => { if (m && valid.has(m) && !seen.has(m)) { seen.add(m); chain.push(m); } };
    for (const m of byRole.get(role) ?? []) { if (chain.length >= 3) break; add(m); } // the LLM's picks (validated)
    for (const m of heuMap.get(role) ?? []) { if (chain.length >= 3) break; add(m); } // pad from the heuristic
    for (const m of models) { if (chain.length >= 3) break; add(m); } // last resort: any model
    // The tuner reasons about capability, not release numbers: it will happily name `claude-opus-4-6` while
    // `claude-opus-5` sits in the same catalog. Upgrading the primary is deterministic, so it does not depend
    // on the tuner noticing.
    // A role whose output is committed and read by later agents gets the best model available, whatever the
    // tuner made of "strong" — see DURABLE_ROLES.
    const tuned = DURABLE_ROLES.includes(role) ? strongestPrimary(chain, models) : chain;
    return { role, models: newestPrimary(tuned, models) };
  });
  // Per-chain diversity is not fleet diversity: rebalance whatever one model ended up carrying for everyone.
  return spreadLoad(built, models);
}

/**
 * Assigns a model chain to every role by having the most capable model REASON over the role profiles + the
 * discovered catalog (cost/capability/source diversity). The rationale STREAMS live via `onReason` (the JSON
 * block is hidden from the stream); its picks are validated against the real catalog, falling back to the
 * deterministic heuristic for anything invalid or on error.
 */
export async function tuneRoleModels(opts: {
  provider: Provider;
  models: string[];
  roles: string[];
  signal?: AbortSignal;
  onReason?: (delta: string) => void; // streamed reasoning text (JSON block excluded)
}): Promise<TunedRoles> {
  const { provider, models, roles } = opts;
  const heuristic = adjustRoleModels(roles, models);
  const tuner = mostCapable(models);
  if (!models.length || !tuner) return { reasoning: "No models available to assign.", chains: heuristic, tuner };

  const profiles = roles.map((r) => `- ${r}: ${ROLE_PROFILES[r] ?? "(a review role — critiques the spec/plan from a specific angle; wants a strong model)"}`).join("\n");
  const systemPrompt =
    `You assign LLM models to the agent roles of a coding assistant. Each role gets a fallback CHAIN: a primary ` +
    `model plus two fallbacks (3 total), tried in order when a source is rate-limited or exhausted.\n\n` +
    `Rules:\n` +
    `1. Use ONLY exact model ids from the catalog below — never invent one.\n` +
    `2. Every role gets EXACTLY 3 DISTINCT models: primary, fallback 1, fallback 2.\n` +
    `3. Prefer fallbacks on a DIFFERENT source than the primary, so one source's exhaustion drops cleanly.\n` +
    `3a. Do NOT give the same model to everyone as a fallback. No single model should appear in more than a \n` +
    `QUARTER of all chains — per-chain source diversity is worthless if every chain ends on the same model, \n` +
    `because they all land on one subscription the moment the others rate-limit.\n` +
    `3b. A fallback is a SUBSTITUTE, not an upgrade: give it the SAME heft band as the primary whenever a \n` +
    `same-band model exists on another source. Standing in for a [mid] model with a [strong] or [flagship] \n` +
    `one silently multiplies cost and latency and defeats the tiering. Only leave the band when no peer exists.\n` +
    `4. Reserve the single most capable/expensive [flagship] model for LOW-VOLUME, high-stakes roles (judge, ` +
    `principal-coder). NEVER put a [flagship] on high-volume or interactive roles (coach, coder, designer) OR ` +
    `on their fallbacks — it is wasteful and slow at that volume.\n` +
    `5. A senior role must be MORE capable than its junior (senior-coder > coder).\n` +
    `6. Spread the high-volume roles across DIFFERENT sources — don't pile them all on one subscription.\n` +
    `7. Fast/coordination roles (refiner, router, project-manager, team-lead) get cheap [fast] models.\n\n` +
    `Roles (with their workload profile):\n${profiles}\n\n` +
    `Available models, grouped by source (subscription), each tagged with its heft band:\n${describeCatalog(models)}\n\n` +
    `First explain your key choices in a few short sentences (which model on judge/coach/coder and why). ` +
    `THEN, on a new line, output ONLY a fenced \`\`\`json block: {"assignments":[{"role":"<role>","models":["<primary>","<fb1>","<fb2>"]}, …]} covering every role.`;

  try {
    const req: ChatRequest = {
      model: tuner,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Assign a 3-model chain to every role. Reason briefly, then give the JSON." },
      ],
      tools: [],
    };
    const stripThink = (s: string): string => s.replace(/<\/?think>/gi, ""); // drop stray thinking-mode tags
    let full = "";
    let cut = -1; // once the JSON block starts, stop forwarding text to the live reasoning stream
    for await (const ev of provider.chat(req, opts.signal ?? new AbortController().signal)) {
      if (ev.type === "text-delta") {
        const start = full.length;
        full += ev.text;
        if (cut < 0) {
          const j = full.search(/```|\n\s*\{/); // JSON block marker
          if (j >= 0) { if (j > start) opts.onReason?.(stripThink(full.slice(start, j))); cut = j; }
          else opts.onReason?.(stripThink(ev.text));
        }
      } else if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }
    const reasoning = stripThink(cut >= 0 ? full.slice(0, cut) : full).trim();
    return {
      reasoning: reasoning || "(no rationale given)",
      chains: validateChains(parseAssignments(full), roles, models, heuristic),
      tuner,
    };
  } catch (e) {
    return {
      reasoning: `Model discussion failed (${e instanceof Error ? e.message : String(e)}) — used the built-in heuristic instead.`,
      chains: heuristic,
      tuner,
    };
  }
}
