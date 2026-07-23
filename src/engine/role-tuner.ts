import type { ChatRequest, Provider } from "../core/types.js";
import { ROLE_PROFILES, adjustRoleModels, modelBand, sourceOf, capabilityScore, mostCapable } from "../tui/role-models.js";

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
  return roles.map((role) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    const add = (m: string) => { if (m && valid.has(m) && !seen.has(m)) { seen.add(m); chain.push(m); } };
    for (const m of byRole.get(role) ?? []) { if (chain.length >= 3) break; add(m); } // the LLM's picks (validated)
    for (const m of heuMap.get(role) ?? []) { if (chain.length >= 3) break; add(m); } // pad from the heuristic
    for (const m of models) { if (chain.length >= 3) break; add(m); } // last resort: any model
    return { role, models: chain };
  });
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
