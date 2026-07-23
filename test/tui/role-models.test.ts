import { describe, it, expect } from "vitest";
import { filterModelsForRole, capabilityScore, baseModel, adjustRoleModels } from "../../src/tui/role-models.js";

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
    expect(r.note).toMatch(/capable model/i);
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

  it("judge gets the single most capable model (fable); analyst gets opus-4-8", () => {
    const out = adjustRoleModels(["judge", "analyst", "planner"], models);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(map.judge).toMatch(/fable/);
    expect(map.analyst).toBe("cc/claude-opus-4-8");
  });

  it("uses codex somewhere (capable tier) and gives fast roles fast models", () => {
    const out = adjustRoleModels(["judge", "analyst", "planner", "coach", "architect", "coder", "designer", "refiner"], models);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(out.some((r) => /codex|gpt-5/.test(r.model))).toBe(true); // codex is drawn into the capable roles
    expect(map.refiner).toMatch(/flash/); // fast role → fast model
    expect(map.judge).toMatch(/fable/); // most capable stays on judge
  });

  it("dedupes the same model across providers (fable counted once)", () => {
    // one reasoning role → fable; a second distinct model, not the other provider's fable
    const out = adjustRoleModels(["judge", "analyst"], ["a/claude-fable-5", "b/claude-fable-5", "c/claude-opus-4-8"]);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(map.judge).toMatch(/fable/);
    expect(map.analyst).toMatch(/opus-4-8/); // not the duplicate fable
  });

  it("empty model list → no assignments", () => {
    expect(adjustRoleModels(["judge"], [])).toEqual([]);
  });
});
