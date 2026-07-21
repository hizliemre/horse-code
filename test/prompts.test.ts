import { describe, it, expect } from "vitest";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_COUNCILORS } from "../src/prompts.js";

describe("prompts", () => {
  it("every REQUIRED_ROLES entry has a non-empty default prompt (except the spec-kit-driven model-only roles)", () => {
    // analyst + planner are driven by the fetched spec-kit command prompts, so they intentionally carry no
    // default prompt here — only a model (resolved via peekModel). See src/speckit/phases.ts.
    const MODEL_ONLY = new Set(["analyst", "planner"]);
    for (const r of REQUIRED_ROLES) {
      if (MODEL_ONLY.has(r)) {
        expect(DEFAULT_PROMPTS[r], r).toBeUndefined();
        continue;
      }
      expect(DEFAULT_PROMPTS[r], r).toBeDefined();
      expect(DEFAULT_PROMPTS[r].length).toBeGreaterThan(0);
    }
  });
  it("principal-coder role is defined (G1)", () => {
    expect(REQUIRED_ROLES).toContain("principal-coder");
    expect(DEFAULT_PROMPTS["principal-coder"]).toBeDefined();
    expect(DEFAULT_PROMPTS["principal-coder"].length).toBeGreaterThan(0);
  });
  it("DEFAULT_COUNCILORS has >=1 member; name+perspective are populated", () => {
    expect(DEFAULT_COUNCILORS.length).toBeGreaterThan(0);
    for (const c of DEFAULT_COUNCILORS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.perspective.length).toBeGreaterThan(0);
    }
  });
});
