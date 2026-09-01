import { describe, it, expect, vi } from "vitest";
import { RoleRegistry, providerOutage } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const reg = (): RoleRegistry => new RoleRegistry({
  analyst: { models: ["cc/opus-5", "cc/opus-4-8"], systemPrompt: "a" },
  coder: { models: ["cc/opus-5", "cc/opus-4-8"], systemPrompt: "c" },
  judge: { models: ["cc/opus-5", "cc/opus-4-8"], systemPrompt: "j" },
}, {}, new SkillRegistry());

/**
 * Measured live: `cc/claude-opus-5` answered in prose twice and was re-assigned away from SIXTEEN roles —
 * the best model in the catalogue removed from every job in the run because two prompts had been hard. The
 * strike was counted per MODEL, so two misses in two unrelated roles added up to a verdict about neither.
 */
describe("a structural miss is about the role first, the model only later", () => {
  it("does not bench the model when one role misses twice", () => {
    const r = reg();
    const recorded: string[] = [];
    r.setFitness({ unfit: () => false, record: (role, m) => { recorded.push(`${role}:${m}`); return 1; } });

    r.markStructuralFailure("cc/opus-5", "prose", "analyst");
    r.markStructuralFailure("cc/opus-5", "prose", "analyst");

    expect(r.isQuarantined("cc/opus-5")).toBe(false);   // still available everywhere else
    expect(recorded).toEqual(["analyst:cc/opus-5"]);    // …and this role now knows
    expect(r.chain("coder")[0]).toBe("cc/opus-5");
  });

  it("benches it once a SECOND, unrelated role fails the same way", () => {
    const r = reg();
    r.setFitness({ unfit: () => false, record: () => 1 });
    for (const role of ["analyst", "coder"]) {
      r.markStructuralFailure("cc/opus-5", "prose", role);
      r.markStructuralFailure("cc/opus-5", "prose", role);
    }
    expect(r.isQuarantined("cc/opus-5")).toBe(true);
  });

  /**
   * A model out of quota is out until the quota returns. A model that answered in prose is a different case:
   * the transport was fine, and the next prompt may not be the one it stumbled on. Benching it for the rest
   * of a multi-hour run costs every role that held it.
   */
  it("lets a behavioural bench lapse, so a long run gets its best model back", () => {
    vi.useFakeTimers();
    try {
      const r = reg();
      r.setFitness({ unfit: () => false, record: () => 1 });
      for (const role of ["analyst", "coder"]) {
        r.markStructuralFailure("cc/opus-5", "prose", role);
        r.markStructuralFailure("cc/opus-5", "prose", role);
      }
      expect(r.isQuarantined("cc/opus-5")).toBe(true);
      vi.advanceTimersByTime(RoleRegistry.STRUCTURAL_BENCH_MS + 1);
      expect(r.isQuarantined("cc/opus-5")).toBe(false);
      expect(r.chain("judge")[0]).toBe("cc/opus-5");
    } finally { vi.useRealTimers(); }
  });

  it("keeps an availability bench for as long as it takes — that one is not behavioural", () => {
    vi.useFakeTimers();
    try {
      const r = reg();
      r.markExhausted("cc/opus-5", "429: weekly usage limit reached");
      vi.advanceTimersByTime(RoleRegistry.STRUCTURAL_BENCH_MS * 10);
      expect(r.isQuarantined("cc/opus-5")).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

/**
 * Twelve of eighteen model errors in one run's first eight minutes were the same sentence:
 * `No active credentials for provider: antigravity`.
 *
 * The quarantine is keyed by model, so each of that provider's models had to fail on its own before the
 * chain gave up on it — and every one of those failures spent an ATTEMPT from the task walking the ladder.
 * `T001` reached attempt 6, the number at which a task is abandoned, having had two or three real tries.
 * The rest went to a source with no credentials.
 */
describe("a failure about the provider, not the model", () => {
  const registry = (): RoleRegistry => new RoleRegistry({
    coder: { models: ["antigravity/claude-sonnet-5", "antigravity/gemini-3.1-pro-low", "cx/gpt-5.6-terra"] },
    "senior-coder": { models: ["antigravity/gemini-3.1-pro-high", "cc/claude-opus-5"] },
  } as never, {} as never);

  it("recognises the gateway's wording", () => {
    expect(providerOutage("No active credentials for provider: antigravity")).toBe("antigravity");
    expect(providerOutage("No active credentials for provider: opencode-go")).toBe("opencode-go");
  });

  /**
   * No credentials and no quota left are the same situation for a chain: this source cannot serve, another
   * can. Measured two minutes into a run — six of these across two models, and not one quarantine, because
   * only the credential wording was known.
   *
   * The name comes from the sentence, not from the bracketed model prefix: the prefix is whichever model
   * happened to ask, and the failure is not about that model.
   */
  it("reads a spent quota as the same source-wide failure", () => {
    const live = "[antigravity/claude-sonnet-4-6-medium] All antigravity accounts have exhausted their quota (reset after 4h)";
    expect(providerOutage(live)).toBe("antigravity");
    expect(providerOutage("All opencode-go accounts have exhausted their quota")).toBe("opencode-go");
  });

  it("is not confused by a failure that is about one model", () => {
    for (const m of ["Overloaded", "Shared egress IP quota exhausted (opencode-go)",
      "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'."]) {
      expect(providerOutage(m), m).toBeUndefined();
    }
  });

  it("benches the whole provider when a quota is spent, not just the model that asked", () => {
    const r = registry();
    const live = "[antigravity/claude-sonnet-5] All antigravity accounts have exhausted their quota (reset after 4h)";
    const provider = providerOutage(live);
    expect(provider).toBe("antigravity");
    const hit = r.markProviderExhausted(provider as string, "antigravity/claude-sonnet-5", live);
    expect(hit).toHaveLength(3);
    expect(r.quarantined().map((q) => q.model)).not.toContain("cx/gpt-5.6-terra");
  });

  it("takes out every model of that provider at once, and leaves the others", () => {
    const r = registry();
    const hit = r.markProviderExhausted("antigravity", "antigravity/claude-sonnet-5", "No active credentials");
    expect(hit).toHaveLength(3);
    const benched = r.quarantined().map((q) => q.model).sort();
    expect(benched).toEqual([
      "antigravity/claude-sonnet-5", "antigravity/gemini-3.1-pro-high", "antigravity/gemini-3.1-pro-low",
    ]);
    expect(benched).not.toContain("cx/gpt-5.6-terra");
    expect(benched).not.toContain("cc/claude-opus-5");
  });

  /** An unknown provider is still a real failure: bench what actually failed rather than nothing at all. */
  it("falls back to the one model when the pool names none of that provider", () => {
    const r = registry();
    const hit = r.markProviderExhausted("someone-else", "someone-else/m", "No active credentials");
    expect(hit).toEqual(["someone-else/m"]);
    expect(r.quarantined().map((q) => q.model)).toEqual(["someone-else/m"]);
  });
});
