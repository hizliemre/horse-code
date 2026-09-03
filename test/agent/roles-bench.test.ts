import { describe, it, expect, vi } from "vitest";
import { RoleRegistry, providerOutage, isSourceCapacity, sourcePrefix } from "../../src/agent/roles.js";
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
    for (const m of ["Overloaded",
      "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'."]) {
      expect(providerOutage(m), m).toBeUndefined();
    }
  });

  /**
   * A shared egress IP belongs to the SOURCE, and this test used to assert the opposite.
   *
   * It listed the message among the model-scoped failures — a reasonable guess that the run disproved. In
   * thirty minutes, twenty-three distinct models each discovered the same exhausted IP on their own:
   * deepseek-v4 in five variants, qwen3.7-plus, glm-5/5.1/5.2, grok-4.5 in two, kimi-k3, mimo-v2 in four,
   * minimax-m2.7. The word "Shared", the provider in the parenthesis, and a reset roughly five days out all
   * say the same thing, and twenty-three models rediscovering one fact is the cost of not reading them.
   */
  it("reads a shared egress IP quota as the source's, not the model's", () => {
    const live = "[opencode-go/deepseek-v4-pro] Shared egress IP quota exhausted (opencode-go) (reset after 114h 2m)";
    expect(providerOutage(live)).toBe("opencode-go");
    expect(providerOutage("Shared egress IP quota exhausted (opencode-go)")).toBe("opencode-go");
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

/**
 * A full admission queue belongs to the SUBSCRIPTION, and it is the one source-wide failure that does not
 * say so in words.
 *
 * "Chat admission capacity is temporarily unavailable. Retry shortly." names no provider, so the source has
 * to be read off the model that ran into it. Measured over one run — 50 refusals across SEVENTEEN models,
 * with the rate a property of the subscription rather than of any of them:
 *
 *   cc            910 calls    5 refusals   0.5%
 *   cx            432 calls   41 refusals   9.5%
 *   antigravity    85 calls    4 refusals   4.7%
 *
 * Benching one model for it moved fourteen roles onto another model of the same congested source, and one
 * observed fallback went `cc/claude-sonnet-4-5-…-high → cx/gpt-5.6-luna-low` — off the source refusing one
 * call in two hundred, onto the one refusing one in ten.
 */
describe("a full admission queue is the subscription's, not the model's", () => {
  it("recognises the gateway's two wordings, and nothing else", () => {
    expect(isSourceCapacity("Chat admission capacity is temporarily unavailable. Retry shortly.")).toBe(true);
    expect(isSourceCapacity("Structurally heavy chat request capacity is busy; retry shortly.")).toBe(true);
    // A model's own refusal is not the queue's — it must still bench just that model.
    expect(isSourceCapacity("This model does not support the effort parameter.")).toBe(false);
    expect(isSourceCapacity("Overloaded")).toBe(false);
  });

  /** `no-think/` is a routing wrapper, not a subscription — it is served by the source it wraps. */
  it("reads the source off the model id, wrapper and all", () => {
    expect(sourcePrefix("cx/gpt-5.6-luna-low")).toBe("cx");
    expect(sourcePrefix("no-think/cc/claude-sonnet-5")).toBe("cc");
    expect(sourcePrefix("bare-model-id")).toBeUndefined();
  });

  it("benches the whole source, including its no-think wrappers", () => {
    const r = new RoleRegistry({
      coder: { models: ["cx/gpt-5.6-luna-low", "no-think/cx/gpt-5.6-terra", "cc/claude-sonnet-5"] },
    } as never, {} as never);
    const hit = r.markProviderExhausted("cx", "cx/gpt-5.6-luna-low",
      "Chat admission capacity is temporarily unavailable. Retry shortly.");
    expect(hit.sort()).toEqual(["cx/gpt-5.6-luna-low", "no-think/cx/gpt-5.6-terra"]);
    expect(r.isQuarantined("cc/claude-sonnet-5")).toBe(false); // the healthy subscription is untouched
  });

  /** Short by construction: "temporarily unavailable" is transient, so the bench is a step aside, not a verdict. */
  it("benches for the transient window rather than the rest of the run", () => {
    vi.useFakeTimers();
    try {
      const r = new RoleRegistry({ coder: { models: ["cx/a", "cc/b"] } } as never, {} as never);
      r.markProviderExhausted("cx", "cx/a", "Chat admission capacity is temporarily unavailable.");
      expect(r.isQuarantined("cx/a")).toBe(true);
      vi.advanceTimersByTime(RoleRegistry.TRANSIENT_BENCH_MS + 1);
      expect(r.isQuarantined("cx/a")).toBe(false);   // the queue drains; the subscription comes back
    } finally { vi.useRealTimers(); }
  });
});

/**
 * …and the wiring, which is where the decision is actually made.
 *
 * The predicates above can both be right while the callback still benches one model: `onExhausted` reads the
 * source from the MESSAGE, and a full admission queue does not name one. Without the fallback to the model's
 * own prefix, the fourteen roles on that subscription are re-chained onto another of its models.
 */
describe("onExhausted routes a capacity refusal to the whole source", () => {
  const roles = {
    coder: { models: ["cx/gpt-5.6-luna-low", "cc/claude-sonnet-5"], systemPrompt: "c" },
    judge: { models: ["cx/gpt-5.6-terra", "cc/claude-opus-5"], systemPrompt: "j" },
  };

  it("benches every model of the congested subscription, not just the one that asked", () => {
    const r = new RoleRegistry(roles as never, {} as never, new SkillRegistry());
    r.resolve("coder").onExhausted?.("cx/gpt-5.6-luna-low",
      "Chat admission capacity is temporarily unavailable. Retry shortly.");
    expect(r.isQuarantined("cx/gpt-5.6-luna-low")).toBe(true);
    expect(r.isQuarantined("cx/gpt-5.6-terra")).toBe(true);   // the other role's cx model goes too
    expect(r.isQuarantined("cc/claude-sonnet-5")).toBe(false); // the healthy subscription is left alone
  });

  /** A refusal that is genuinely about one model must still bench only that model. */
  it("leaves the rest of the source alone for a model's own refusal", () => {
    const r = new RoleRegistry(roles as never, {} as never, new SkillRegistry());
    r.resolve("coder").onExhausted?.("cx/gpt-5.6-luna-low", "Overloaded");
    expect(r.isQuarantined("cx/gpt-5.6-luna-low")).toBe(true);
    expect(r.isQuarantined("cx/gpt-5.6-terra")).toBe(false);
  });
});
