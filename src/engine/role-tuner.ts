import { z } from "zod";
import type { Provider } from "../core/types.js";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionEngine } from "../permission/engine.js";
import { ROLE_PROFILES, adjustRoleModels, modelBand, sourceOf, capabilityScore } from "../tui/role-models.js";

/** The LLM's answer: a short rationale plus a primary+fallbacks chain per role. */
const AssignmentSchema = z.object({
  reasoning: z.string().describe("A few sentences on the KEY assignment choices (which model on judge/coach/coder and why)."),
  assignments: z.array(z.object({
    role: z.string(),
    models: z.array(z.string()).describe("Exactly 3 model ids from the catalog: primary first, then two fallbacks."),
  })),
});

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
 * Assigns a model chain to every role by having a capable model REASON over the role profiles + the discovered
 * catalog (cost/capability/source diversity), then validates its picks against the real catalog — falling back
 * to the deterministic heuristic for anything invalid or on error. The rationale is returned for display in chat.
 */
export async function tuneRoleModels(opts: {
  provider: Provider;
  models: string[];
  roles: string[];
  signal?: AbortSignal;
}): Promise<TunedRoles> {
  const { provider, models, roles } = opts;
  const heuristic = adjustRoleModels(roles, models);
  const tuner = [...models].sort((a, b) => capabilityScore(b) - capabilityScore(a))[0] ?? "";
  if (!models.length || !tuner) return { reasoning: "No models available to assign.", chains: heuristic, tuner };

  const profiles = roles.map((r) => `- ${r}: ${ROLE_PROFILES[r] ?? "(a support role)"}`).join("\n");
  const systemPrompt =
    `You are assigning LLM models to the agent roles of a coding assistant. Each role gets a fallback CHAIN: a ` +
    `primary model plus two fallbacks (3 total), tried in order when a source is rate-limited or exhausted.\n\n` +
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
    `Think it through briefly, then call submit with your reasoning and the per-role assignments.`;

  try {
    const result = await runStructuredRole({
      provider,
      model: tuner,
      systemPrompt,
      tools: new ToolRegistry(),
      messages: [{ role: "user", content: "Assign a 3-model chain to every role, then submit." }],
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      cwd: ".",
      signal: opts.signal ?? new AbortController().signal,
    }, AssignmentSchema);
    return {
      reasoning: result.reasoning.trim() || "(no rationale given)",
      chains: validateChains(result.assignments, roles, models, heuristic),
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
