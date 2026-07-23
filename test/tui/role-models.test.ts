import { describe, it, expect } from "vitest";
import { filterModelsForRole } from "../../src/tui/role-models.js";

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
