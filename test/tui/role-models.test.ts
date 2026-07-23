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
  const models = ["cc/claude-opus-4-8", "cc/claude-sonnet-5", "opencode-go/deepseek-v4-flash", "provider/gpt-5-mini"];
  it("gives strong roles the most capable model, others the best fast model", () => {
    const out = adjustRoleModels(["analyst", "planner", "coach", "refiner", "project-manager"], models);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(map.analyst).toBe("cc/claude-opus-4-8");
    expect(map.planner).toBe("cc/claude-opus-4-8");
    expect(map.coach).toBe("cc/claude-opus-4-8");
    expect(map.refiner).toBe("opencode-go/deepseek-v4-flash"); // best fast model (flash ranks over mini? equal → first)
    expect(map["project-manager"]).not.toBe("cc/claude-opus-4-8"); // non-strong → fast
  });

  it("falls back to the best model for fast roles when no fast model exists", () => {
    const out = adjustRoleModels(["refiner", "analyst"], ["a/opus", "b/sonnet"]);
    const map = Object.fromEntries(out.map((r) => [r.role, r.model]));
    expect(map.refiner).toBe("a/opus"); // no fast model → best
    expect(map.analyst).toBe("a/opus");
  });

  it("empty model list → no assignments", () => {
    expect(adjustRoleModels(["analyst"], [])).toEqual([]);
  });
});
