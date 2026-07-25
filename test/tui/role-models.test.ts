import { describe, it, expect } from "vitest";
import { filterModelsForRole, capabilityScore, baseModel, adjustRoleModels, modelBand, isKnownModel } from "../../src/tui/role-models.js";

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
