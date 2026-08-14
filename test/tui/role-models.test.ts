import { describe, it, expect } from "vitest";
import { filterModelsForRole, capabilityScore, baseModel, adjustRoleModels, modelBand, isKnownModel, modelFamily, versionlessId, newestPrimary, strongestPrimary, DURABLE_ROLES } from "../../src/tui/role-models.js";

const ALL = [
  "cc/claude-opus-4-8",
  "cc/claude-sonnet-5",
  "opencode-go/deepseek-v4-flash",
  "provider/gpt-5-mini",
  "provider/llama-8b",
];

describe("filterModelsForRole", () => {
  it("capable roles (analyst/judge) hide weak/fast models and explain why", () => {
    const r = filterModelsForRole("judge", ALL);
    expect(r.models).toEqual(["cc/claude-opus-4-8", "cc/claude-sonnet-5"]);
    expect(r.models).not.toContain("provider/gpt-5-mini"); // "mini" → fast
    expect(r.note).toMatch(/most capable|flagship/i);
    expect(r.note).toContain("2 of 5");
  });

  it("the refiner keeps only fast/cheap models", () => {
    const r = filterModelsForRole("refiner", ALL);
    expect(r.models).toEqual(["opencode-go/deepseek-v4-flash", "provider/gpt-5-mini", "provider/llama-8b"]);
    expect(r.note).toMatch(/fast/i);
  });

  it("never strands the user: if the filter would empty the list, show all with a note", () => {
    const onlyWeak = ["a/flash", "b/mini"];
    const r = filterModelsForRole("planner", onlyWeak);
    expect(r.models).toEqual(onlyWeak);
    expect(r.note).toMatch(/No strong models detected/i);
  });
});

describe("capabilityScore", () => {
  it("fable is the top, opus is version-aware, sonnet/codex below", () => {
    expect(capabilityScore("cc/claude-fable-5")).toBe(100);
    expect(capabilityScore("cc/claude-opus-4-8")).toBeGreaterThan(capabilityScore("cc/claude-opus-4-5"));
    expect(capabilityScore("cc/claude-fable-5")).toBeGreaterThan(capabilityScore("cc/claude-opus-4-8"));
    expect(capabilityScore("cc/claude-opus-4-8")).toBeGreaterThan(capabilityScore("cx/gpt-5.6-sol-high"));
  });

  it("a bare major release outranks the older dotted versions of the same family (opus-5 > opus-4-8)", () => {
    // Regression: the version was only read from a "4-8"/"4.6" pattern, so a brand-new "opus-5" scored 0 on
    // version and landed BELOW opus-4-8 — a new generation would never be assigned to any role.
    expect(capabilityScore("cc/claude-opus-5")).toBeGreaterThan(capabilityScore("cc/claude-opus-4-8"));
    expect(capabilityScore("cc/claude-sonnet-5")).toBeGreaterThan(capabilityScore("cc/claude-sonnet-4-6"));
    // A date suffix must not be mistaken for the version.
    expect(capabilityScore("cc/claude-opus-4-5-20251101")).toBeLessThan(capabilityScore("cc/claude-opus-4-8"));
    expect(capabilityScore("cc/claude-opus-4-5-20251101")).toBeGreaterThan(capabilityScore("cc/claude-sonnet-5"));
  });

  it("Gemini is capable (not fast) but Gemini-flash IS fast", () => {
    expect(capabilityScore("antigravity/gemini-3.1-pro-high")).toBeGreaterThan(30); // not fast
    expect(capabilityScore("antigravity/gemini-3.5-flash-high")).toBeLessThan(30); // flash → fast tier
  });

  it("codex effort suffix nudges the score (ultra > low)", () => {
    expect(capabilityScore("cx/gpt-5.6-sol-ultra")).toBeGreaterThan(capabilityScore("cx/gpt-5.6-sol-low"));
  });
});

describe("baseModel", () => {
  it("collapses nested provider prefixes + variant/date suffixes", () => {
    expect(baseModel("no-think/cc/claude-opus-4-8")).toBe(baseModel("cc/claude-opus-4-8"));
    expect(baseModel("cc/claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(baseModel("cx/gpt-5.6-sol-ultra")).toBe("gpt-5.6-sol");
  });
});

describe("adjustRoleModels", () => {
  const models = [
    "cc/claude-fable-5", "claude/claude-fable-5", // duplicate fable across providers
    "cc/claude-opus-4-8", "cc/claude-opus-4-6", "cc/claude-sonnet-5",
    "cx/gpt-5.6-sol-ultra", "cx/gpt-5.5-high",
    "antigravity/gemini-3.5-flash-high", "oc/deepseek-v4-flash",
  ];
  const primary = (out: { role: string; models: string[] }[]): Record<string, string> =>
    Object.fromEntries(out.map((r) => [r.role, r.models[0]]));

  it("judge gets the single most capable model (fable); analyst gets opus-4-8", () => {
    const out = adjustRoleModels(["judge", "analyst", "planner"], models);
    const map = primary(out);
    expect(map.judge).toMatch(/fable/);
    expect(map.analyst).toBe("cc/claude-opus-4-8");
  });

  it("uses codex somewhere (capable tier) and gives fast roles fast models", () => {
    const out = adjustRoleModels(["judge", "analyst", "planner", "coach", "architect", "coder", "designer", "refiner"], models);
    const map = primary(out);
    expect(out.some((r) => /codex|gpt-5/.test(r.models[0]))).toBe(true); // codex is drawn into the coding roles
    expect(map.refiner).toMatch(/flash/); // fast role → fast model
    expect(map.judge).toMatch(/fable/); // most capable stays on judge
  });

  it("assigns a 3-model chain (primary + 2 fallbacks) to every role", () => {
    const out = adjustRoleModels(["judge", "analyst", "coder", "refiner"], models);
    for (const r of out) {
      expect(r.models.length).toBe(3);
      expect(new Set(r.models).size).toBe(3); // no model repeats within a chain
    }
  });

  it("chain fallbacks prefer different sources than the primary", () => {
    const out = adjustRoleModels(["judge"], models);
    const chain = out[0].models;
    const src = (m: string) => (m.startsWith("cc/") || m.startsWith("claude/") ? "claude" : m.split("/")[0]);
    expect(src(chain[0])).not.toBe(src(chain[1])); // primary and first fallback are on different sources
  });

  it("spreads coding-role primaries across sources instead of piling on one", () => {
    // reasoning tier consumes the opuses → coding roles must not ALL land on codex
    const out = adjustRoleModels(
      ["judge", "analyst", "planner", "coach", "architect", "coder", "senior-coder", "principal-coder", "designer"],
      models,
    );
    const coding = out.filter((r) => ["coder", "senior-coder", "principal-coder", "designer"].includes(r.role));
    const sources = new Set(coding.map((r) => r.models[0].split("/")[0]));
    expect(sources.size).toBeGreaterThan(1); // more than one source used across coding primaries
  });

  it("dedupes the same model across providers (fable counted once)", () => {
    const out = adjustRoleModels(["judge", "analyst"], ["a/claude-fable-5", "b/claude-fable-5", "c/claude-opus-4-8"]);
    const map = primary(out);
    expect(map.judge).toMatch(/fable/);
    expect(map.analyst).toMatch(/opus-4-8/); // not the duplicate fable
  });

  it("empty model list → no assignments", () => {
    expect(adjustRoleModels(["judge"], [])).toEqual([]);
  });
});

describe("tier eligibility (only real, rankable LLMs get reasoning roles)", () => {
  it("unrecognised endpoints (video/vanity) are not treated as models", () => {
    expect(isKnownModel("cc/claude-opus-4-8")).toBe(true);
    expect(isKnownModel("antigravity/gemini-3.1-pro-high")).toBe(true);
    expect(isKnownModel("opencode-go/deepseek-v4-pro")).toBe(true);
    expect(isKnownModel("veo-free/veo")).toBe(false);      // video model
    expect(isKnownModel("oc/big-pickle")).toBe(false);     // vanity endpoint
    expect(isKnownModel("pepper/pepper-1")).toBe(false);
  });

  it("a model we cannot rank is NOT 'mid' — it must not outrank a known model for a review lens", () => {
    expect(modelBand("oc/qwen3.6-plus-free")).toBe("fast");   // recognised family, no ranking signal
    expect(modelBand("ddgw/llama-4-scout")).toBe("fast");
    expect(modelBand("cc/claude-sonnet-4-6")).toBe("mid");    // genuinely mid
    expect(modelBand("antigravity/gemini-3.1-pro")).toBe("mid");
    expect(modelBand("cc/claude-opus-4-8")).toBe("strong");
    expect(modelBand("cc/claude-fable-5")).toBe("flagship");
  });

  it("adjust never hands a review lens an unrankable/unknown endpoint when real models exist", () => {
    const models = [
      "cc/claude-fable-5", "cc/claude-opus-4-8", "aug/claude-opus-4.6", "cx/gpt-5.6-sol-ultra",
      "cc/claude-sonnet-4-6", "antigravity/gemini-3.1-pro-high", "opencode-go/deepseek-v4-pro",
      "veo-free/veo", "oc/big-pickle", "pepper/pepper-1", "cc/claude-haiku-4-5",
    ];
    const roles = ["judge", "spec-scope", "spec-clarity", "plan-security", "code-correctness", "refiner"];
    const out = adjustRoleModels(roles, models);
    const junk = /veo|big-pickle|pepper/;
    for (const a of out) expect(a.models[0], a.role).not.toMatch(junk); // no junk as a PRIMARY
    const by = Object.fromEntries(out.map((a) => [a.role, a.models[0]]));
    expect(modelBand(by["spec-scope"])).toBe("mid");        // spec lenses → capable but efficient
    expect(modelBand(by["plan-security"])).toBe("strong");  // plan/code lenses → strong
    expect(modelBand(by["code-correctness"])).toBe("strong");
    expect(by["judge"]).toBe("cc/claude-fable-5");          // flagship for the final authority
  });
});

// Observed in the wild: `antigravity/claude-sonnet-4-6` (mid) fell back to `cc/claude-opus-4-8` (strong) even
// though a same-band model on another source was sitting right there in the catalog.
describe("a fallback is a substitute, not an upgrade", () => {
  const catalog = [
    "cc/claude-opus-4-8",            // strong
    "cc/claude-sonnet-5",            // mid  — newest of the sonnet family
    "antigravity/claude-sonnet-4-6", // mid  — older sibling, DIFFERENT source
    "cx/gpt-5.6-luna-max",           // strong
    "cc/claude-haiku-4-5",           // fast
  ];
  const chainOf = (role: string): string[] =>
    adjustRoleModels([role], catalog).find((c) => c.role === role)!.models;
  const src = (m: string): string => m.split("/")[0];

  it("a mid primary falls back to a mid model, not up a band", () => {
    const chain = chainOf("coach"); // coach is a MID role
    expect(modelBand(chain[0])).toBe("mid");
    expect(modelBand(chain[1])).toBe("mid"); // the peer, not the Opus-tier model
  });

  // Source diversity is still what a fallback is FOR — the failure it survives is an exhausted subscription,
  // so a same-source fallback would be dead weight. Band closeness only decides AMONG cross-source candidates.
  it("still prefers a different source", () => {
    const chain = chainOf("coach");
    expect(src(chain[1])).not.toBe(src(chain[0]));
  });

  it("leaves the band when no same-band peer exists, rather than stranding the role", () => {
    const noPeer = ["antigravity/claude-sonnet-4-6", "cc/claude-opus-4-8", "cx/gpt-5.6-luna-max"];
    const chain = adjustRoleModels(["coach"], noPeer).find((c) => c.role === "coach")!.models;
    expect(chain.length).toBeGreaterThan(1); // it still gets fallbacks…
    expect(chain[1]).not.toBe(chain[0]);      // …just from a neighbouring band
  });

  it("at equal distance it errs UPWARD — a fallback must still be able to do the work", () => {
    // primary is mid; a strong and a fast model are both one band away.
    const models = ["antigravity/claude-sonnet-4-6", "cc/claude-opus-4-8", "cx/claude-haiku-4-5"];
    const chain = adjustRoleModels(["coach"], models).find((c) => c.role === "coach")!.models;
    expect(modelBand(chain[1])).toBe("strong");
  });
});

// "her zaman her model'in en son versiyonunu seçmeye meyilli olmalı" — a BIAS, not a filter: the older sibling
// stays available (it is the obvious substitute when the newest is rate-limited), it just never wins first pick.
describe("prefers the newest release of a family", () => {
  it("leads with sonnet-5 over sonnet-4-6 for a mid primary", () => {
    const catalog = ["antigravity/claude-sonnet-4-6", "cc/claude-sonnet-5", "cc/claude-opus-4-8"];
    const chain = adjustRoleModels(["coach"], catalog).find((c) => c.role === "coach")!.models;
    expect(baseModel(chain[0])).toBe("claude-sonnet-5");
  });

  it("keeps the older sibling as a fallback rather than discarding it", () => {
    const catalog = ["antigravity/claude-sonnet-4-6", "cc/claude-sonnet-5", "cc/claude-opus-4-8"];
    const chain = adjustRoleModels(["coach"], catalog).find((c) => c.role === "coach")!.models;
    expect(chain.map(baseModel)).toContain("claude-sonnet-4-6");
  });

  // The GPT family ignored its version entirely: gpt-5.6-luna-max and gpt-5.5-xhigh both scored 86, so the
  // OLDER one could win purely on list order.
  it("ranks gpt-5.6 above gpt-5.5 at equal reasoning effort", () => {
    expect(capabilityScore("cx/gpt-5.6-max")).toBeGreaterThan(capabilityScore("cx/gpt-5.5-max"));
  });

  it("the version is a tiebreak, not a tier mover — effort still dominates", () => {
    expect(capabilityScore("cx/gpt-5.5-max")).toBeGreaterThan(capabilityScore("cx/gpt-5.6-low"));
    expect(modelBand("cx/gpt-5.6-max")).toBe(modelBand("cx/gpt-5.5-max"));
  });

  it("modelFamily strips the version but keeps the identity", () => {
    expect(modelFamily("cc/claude-sonnet-5")).toBe(modelFamily("antigravity/claude-sonnet-4-6"));
    expect(modelFamily("cc/claude-opus-4-8")).not.toBe(modelFamily("cc/claude-sonnet-5"));
  });
});

// Gemini never showed up in role assignments. Not a hard exclusion — the heuristic did pick some — but its
// score was PINNED at a flat 65: every generation scored identically and the -high/-low effort suffix was
// ignored, so a current Gemini Pro was ranked as if it were the first one, and the LLM tuner reading that
// catalog had no reason to ever choose it.
describe("Gemini is ranked like every other family we recognise", () => {
  it("a newer generation outranks an older one", () => {
    expect(capabilityScore("antigravity/gemini-3.1-pro-high")).toBeGreaterThan(capabilityScore("antigravity/gemini-2.5-pro"));
    expect(capabilityScore("antigravity/gemini-2.5-pro")).toBeGreaterThan(capabilityScore("antigravity/gemini-1.5-pro"));
  });

  it("reasoning effort counts, as it does for the codex/gpt family", () => {
    expect(capabilityScore("antigravity/gemini-3.1-pro-high")).toBeGreaterThan(capabilityScore("antigravity/gemini-3.1-pro-low"));
  });

  // ids separate with underscores as well as dashes; \bpro\b never matches after "_" (a word character).
  it("recognises underscore-separated ids", () => {
    expect(capabilityScore("tllm/gemini_3_pro")).toBeGreaterThan(capabilityScore("tllm/gemini_2_5_pro"));
    expect(modelBand("tllm/gemini_3_pro")).toBe("mid");
  });

  it("a current Gemini Pro lands in the same band as a Sonnet, not below everything", () => {
    expect(modelBand("antigravity/gemini-3.1-pro-high")).toBe("mid");
  });

  it("flash variants stay in the fast band (that part was always right)", () => {
    expect(modelBand("antigravity/gemini-3.5-flash-high")).toBe("fast");
  });

  it("plain gpt-4 keeps its old score — only the Gemini branch changed", () => {
    expect(capabilityScore("openai/gpt-4")).toBe(65);
  });
});

// isKnownModel exists precisely so image/video endpoints never win a reasoning slot, but the family regex
// waved them through whenever they carried a known family name.
describe("non-text endpoints are not assignable models", () => {
  it.each([
    "antigravity/gemini-3-pro-image-preview",
    "antigravity/gemini-3.1-flash-image",
    "antigravity/gemini-2.5-computer-use-preview-10-2025",
    "x/veo-3-video",
    "x/whisper-audio",
    "x/text-embedding-3-large",
  ])("rejects %s", (m) => expect(isKnownModel(m)).toBe(false));

  it.each([
    "antigravity/gemini-3.1-pro-high",
    "cc/claude-opus-4-8",
    "cx/gpt-5.6-sol-ultra",
  ])("still accepts %s", (m) => expect(isKnownModel(m)).toBe(true));

  it("keeps image endpoints out of assignments entirely", () => {
    const catalog = ["antigravity/gemini-3-pro-image-preview", "antigravity/gemini-3.1-pro-high", "cc/claude-opus-4-8"];
    const used = new Set(adjustRoleModels(["coach", "judge"], catalog).flatMap((r) => r.models));
    expect([...used].some((m) => /image/.test(m))).toBe(false);
  });
});

/**
 * A role could come back on `cc/claude-opus-4-6` while `cc/claude-opus-5` sat in the same catalog: the pool
 * ordering only BIASED towards the newest release, and the LLM tuner is free to name any valid id.
 */
describe("versionlessId — what counts as the same model, one release apart", () => {
  it("treats every release of one model on one source as the same key", () => {
    const k = versionlessId("cc/claude-opus-5");
    expect(versionlessId("cc/claude-opus-4-8")).toBe(k);
    expect(versionlessId("cc/claude-opus-4-5-20251101")).toBe(k); // a date stamp is not a version
  });

  it("does NOT merge across sources — an upgrade must not move a role to another subscription", () => {
    expect(versionlessId("aug/claude-opus-4.6")).not.toBe(versionlessId("cc/claude-opus-5"));
    expect(versionlessId("no-think/cc/claude-opus-4-6")).not.toBe(versionlessId("cc/claude-opus-5"));
  });

  it("does NOT merge across variants — a no-think or thinking model is not the same model", () => {
    expect(versionlessId("antigravity/claude-opus-4-6-thinking"))
      .not.toBe(versionlessId("antigravity/claude-opus-4-6"));
    // …and modelFamily, which this deliberately does not reuse, DOES conflate them:
    expect(modelFamily("antigravity/claude-opus-4-6-thinking")).toBe(modelFamily("no-think/cc/claude-opus-4-6"));
  });
});

describe("newestPrimary — the primary slot gets the newest release", () => {
  const POOL = ["cc/claude-opus-5", "cc/claude-opus-4-8", "cc/claude-opus-4-6", "cx/gpt-5.6-sol-high", "aug/claude-opus-4.6"];

  it("upgrades an older primary to the newest release of the same model", () => {
    expect(newestPrimary(["cc/claude-opus-4-6", "cx/gpt-5.6-sol-high", "aug/claude-opus-4.6"], POOL)[0])
      .toBe("cc/claude-opus-5");
  });

  it("leaves the FALLBACKS alone — the previous version is the substitute you want when the newest is limited", () => {
    const out = newestPrimary(["cc/claude-opus-4-6", "cc/claude-opus-4-8", "cx/gpt-5.6-sol-high"], POOL);
    expect(out).toEqual(["cc/claude-opus-5", "cc/claude-opus-4-8", "cx/gpt-5.6-sol-high"]);
  });

  it("swaps rather than duplicates when the newest release is already a fallback", () => {
    const out = newestPrimary(["cc/claude-opus-4-8", "cc/claude-opus-5", "cx/gpt-5.6-sol-high"], POOL);
    expect(out).toEqual(["cc/claude-opus-5", "cc/claude-opus-4-8", "cx/gpt-5.6-sol-high"]);
    expect(new Set(out).size).toBe(3);
  });

  it("never moves the primary to a different source, even for a higher-scoring model", () => {
    expect(newestPrimary(["aug/claude-opus-4.6", "cx/gpt-5.6-sol-high"], POOL)[0]).toBe("aug/claude-opus-4.6");
  });

  it("is a no-op when the primary already is the newest, or the chain is empty", () => {
    expect(newestPrimary(["cc/claude-opus-5", "cc/claude-opus-4-8"], POOL)).toEqual(["cc/claude-opus-5", "cc/claude-opus-4-8"]);
    expect(newestPrimary([], POOL)).toEqual([]);
  });
});

describe("adjustRoleModels leads every chain with the newest release", () => {
  it("never hands a role an older Opus while a newer one is in the pool", () => {
    const pool = ["cc/claude-opus-5", "cc/claude-opus-4-8", "cc/claude-opus-4-6", "cc/claude-sonnet-5", "cc/claude-haiku-4-5-20251001"];
    for (const { models } of adjustRoleModels(["judge", "coder", "coach", "senior-coder", "team-lead"], pool)) {
      const head = models[0]!;
      if (!/opus/.test(head)) continue;
      expect(head).toBe("cc/claude-opus-5");
    }
  });
});

describe("strongestPrimary — a durable-output role gets the best model, not merely a qualifying one", () => {
  // The catalogue as it actually was when the tuner got this wrong.
  const POOL = ["cx/gpt-5.6-terra-medium", "cc/claude-opus-4-5-20251101", "antigravity/claude-opus-4-6-thinking",
    "cc/claude-opus-5", "cc/claude-fable-5"];

  it("fixes the measured case: `strong` spans 84 to 99, so obeying the instruction was not enough", () => {
    // Both are `strong`. The tuner picked the 84.1 one and was, strictly, compliant.
    expect(modelBand("cx/gpt-5.6-terra-medium")).toBe("strong");
    expect(modelBand("cc/claude-opus-5")).toBe("strong");
    expect(capabilityScore("cc/claude-opus-5")).toBeGreaterThan(capabilityScore("cx/gpt-5.6-terra-medium"));

    const tuned = ["cx/gpt-5.6-terra-medium", "cc/claude-opus-4-5-20251101", "antigravity/claude-opus-4-6-thinking"];
    expect(strongestPrimary(tuned, POOL)[0]).toBe("cc/claude-opus-5");
  });

  it("does not take the flagship — it belongs to the adjudicating roles", () => {
    expect(modelBand("cc/claude-fable-5")).toBe("flagship");
    expect(strongestPrimary(["cx/gpt-5.6-terra-medium"], POOL)).not.toContain("cc/claude-fable-5");
  });

  it("swaps rather than duplicates when the best model is already a fallback", () => {
    const out = strongestPrimary(["cx/gpt-5.6-terra-medium", "cc/claude-opus-5"], POOL);
    expect(out).toEqual(["cc/claude-opus-5", "cx/gpt-5.6-terra-medium"]);
    expect(new Set(out).size).toBe(2);
  });

  it("keeps the rest of the chain, so a limited primary still falls back to what the tuner chose", () => {
    const out = strongestPrimary(["cx/gpt-5.6-terra-medium", "cc/claude-opus-4-5-20251101"], POOL);
    expect(out.slice(1)).toEqual(["cc/claude-opus-4-5-20251101"]);
  });

  it("is a no-op on an empty chain or when the primary already is the best", () => {
    expect(strongestPrimary([], POOL)).toEqual([]);
    expect(strongestPrimary(["cc/claude-opus-5", "cx/gpt-5.6-terra-medium"], POOL))
      .toEqual(["cc/claude-opus-5", "cx/gpt-5.6-terra-medium"]);
  });

  it("applies to the tracer — its output is a committed file every later agent reads", () => {
    expect(DURABLE_ROLES).toContain("tracer");
  });
});

/**
 * A role's effort is chosen by the same reasoning that chooses its model — so `/roles adjust` must set both.
 *
 * Effort is not part of a Claude model's id. In the codex/gpt family every level is sold as its own model
 * (`cx/gpt-5.5-xhigh`), so an assignment that picks the model has already picked the level; a Claude id names
 * the model and nothing else. Before this, a carefully reasoned assignment left every Claude role at the
 * API's default however deliberately its band had been argued.
 */
describe("the effort that goes with a role's model", () => {
  it("gives a decider the most thorough pass there is — it runs rarely and decides", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("judge", "cc/claude-opus-5")).toBe("max");
    expect(effortFor("principal-coder", "cc/claude-opus-5")).toBe("max");
  });

  it("gives serious reasoning the coding/agentic setting", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("analyst", "cc/claude-opus-4-8")).toBe("xhigh");
    expect(effortFor("code-correctness", "cc/claude-sonnet-5")).toBe("xhigh");
  });

  it("keeps the high-volume roles at the API's own level rather than multiplying their cost", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("coder", "cc/claude-sonnet-5")).toBe("high");
    expect(effortFor("coach", "cc/claude-sonnet-5")).toBe("high");
  });

  it("tells a router not to think about it", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("refiner", "cc/claude-haiku-4-5-20251001")).toBe("low");
    expect(effortFor("project-manager", "cc/claude-sonnet-5")).toBe("low");
  });

  /**
   * Not "high" — the absence of a level, so the field is never sent. A number that does nothing in the config
   * is a number someone will later try to tune.
   */
  it("says nothing at all for a model whose effort cannot be set", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("judge", "cx/gpt-5.6-terra")).toBeUndefined();
    expect(effortFor("coder", "tllm/gemini_3_pro")).toBeUndefined();
    expect(effortFor("refiner", "")).toBeUndefined();
  });

  it("leaves a role no band claims to the API as well", async () => {
    const { effortFor } = await import("../../src/tui/role-models.js");
    expect(effortFor("some-future-role", "cc/claude-opus-5")).toBeUndefined();
  });
});

/** Assigned in the session that ran the adjust, and written down for the next one. */
describe("where /roles adjust puts the level", () => {
  const src = (f: string): Promise<string> => import("node:fs/promises").then((m) => m.readFile(f, "utf8"));

  it("sets it on the live registry beside the chain", async () => {
    expect(await src("src/tui/app.tsx"))
      .toContain('regFor(role).setRoleEffort(role, effortFor(role, chain[0] ?? ""));');
  });

  it("writes it with the tuner's chains, not only with a hand-set one", async () => {
    const s = await src("src/tui/app.tsx");
    expect(s).toContain("const withEffort = chains.map");
    expect(s).toContain("saveRoleChains(homedir(), withEffort)");
  });

  it("removes a stored level when the role's new model has none — a stale number applies to nothing", async () => {
    const s = await src("src/config/save-roles.ts");
    expect(s).toContain("if (effort) next.effort = effort;");
    expect(s).toContain("else delete next.effort;");
  });
});
