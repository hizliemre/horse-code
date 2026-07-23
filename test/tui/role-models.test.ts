import { describe, it, expect } from "vitest";
import { filterModelsForRole, capabilityScore, adjustRoleModels } from "../../src/tui/role-models.js";

const ALL = [
  "cc/claude-opus-4-8",
  "cc/claude-sonnet-5",
  "opencode-go/deepseek-v4-flash",
  "provider/gpt-5-mini",
  "provider/llama-8b",
];

describe("filterModelsForRole", () => {
  it("strong roles (analyst/planner) hide weak/fast models and explain why", () => {
    const r = filterModelsForRole("analyst", ALL);
    expect(r.models).toEqual(["cc/claude-opus-4-8", "cc/claude-sonnet-5"]);
    expect(r.models).not.toContain("opencode-go/deepseek-v4-flash");
    expect(r.models).not.toContain("provider/gpt-5-mini");
    expect(r.models).not.toContain("provider/llama-8b");
    expect(r.note).toMatch(/strong model/i);
    expect(r.note).toContain("2 of 5");
  });

  it("the refiner keeps only fast/cheap models", () => {
    const r = filterModelsForRole("refiner", ALL);
    expect(r.models).toEqual(["opencode-go/deepseek-v4-flash", "provider/gpt-5-mini", "provider/llama-8b"]);
    expect(r.note).toMatch(/fast/i);
  });

  it("other roles (coder) are unfiltered, no note", () => {
    expect(filterModelsForRole("coder", ALL)).toEqual({ models: ALL });
  });

  it("never strands the user: if the filter would empty the list, show all with a note", () => {
    const onlyWeak = ["a/flash", "b/mini"];
    const r = filterModelsForRole("planner", onlyWeak);
    expect(r.models).toEqual(onlyWeak); // fell back to all
    expect(r.note).toMatch(/No strong models detected/i);
  });
});

describe("capabilityScore", () => {
  it("ranks opus > sonnet > mid > fast", () => {
    expect(capabilityScore("cc/claude-opus-4-8")).toBeGreaterThan(capabilityScore("cc/claude-sonnet-5"));
    expect(capabilityScore("cc/claude-sonnet-5")).toBeGreaterThan(capabilityScore("opencode-go/deepseek-v4-flash"));
    expect(capabilityScore("provider/gpt-5-mini")).toBe(30); // "mini" → fast tier, despite gpt-5
    expect(capabilityScore("some/deepseek-v4")).toBe(75); // non-flash deepseek → mid
  });
});

describe("adjustRoleModels", () => {
  it("spreads strong roles across providers (each a top model of a different source), not all on one", () => {
    const models = [
      "antigravity/opus-x", "antigravity/sonnet-x",
      "claude/opus-4-8", "codex/gpt-5", "opencode-go/deepseek-v4",
    ];
    const out = adjustRoleModels(["analyst", "planner", "coach", "judge"], models);
    const providers = out.map((r) => r.model.split("/")[0]);
    // 4 strong roles → 4 distinct providers (no single source hogs them all)
    expect(new Set(providers).size).toBe(4);
    expect(providers.filter((p) => p === "antigravity")).toHaveLength(1); // antigravity gets one, not all
  });

  it("strong roles get capable (non-fast) models; fast roles get fast models", () => {
    const models = ["a/opus", "b/sonnet", "c/flash", "d/mini"];
    const out = adjustRoleModels(["analyst", "planner", "refiner", "team-lead"], models);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(["a/opus", "b/sonnet"]).toContain(map.analyst);
    expect(["a/opus", "b/sonnet"]).toContain(map.planner);
    expect(map.analyst).not.toBe(map.planner); // spread, not the same model twice
    expect(["c/flash", "d/mini"]).toContain(map.refiner);
    expect(["c/flash", "d/mini"]).toContain(map["team-lead"]);
  });

  it("round-robins (wraps) when there are more roles than models in a tier", () => {
    const out = adjustRoleModels(["analyst", "planner", "coach"], ["a/opus", "b/sonnet"]);
    const strong = out.map((r) => r.model);
    expect(strong).toEqual(["a/opus", "b/sonnet", "a/opus"]); // wraps back around
  });

  it("falls back to the capable pool for fast roles when no fast model exists", () => {
    const out = adjustRoleModels(["refiner", "analyst"], ["a/opus", "b/sonnet"]);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(["a/opus", "b/sonnet"]).toContain(map.refiner); // no fast model → uses capable pool
  });

  it("empty model list → no assignments", () => {
    expect(adjustRoleModels(["analyst"], [])).toEqual([]);
  });
});
