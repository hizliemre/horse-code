import { describe, it, expect } from "vitest";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_COUNCILORS } from "../src/prompts.js";

describe("prompts", () => {
  it("her REQUIRED_ROLES için boş olmayan varsayılan prompt var", () => {
    for (const r of REQUIRED_ROLES) {
      expect(DEFAULT_PROMPTS[r], r).toBeDefined();
      expect(DEFAULT_PROMPTS[r].length).toBeGreaterThan(0);
    }
  });
  it("principal-coder rolü tanımlı (G1)", () => {
    expect(REQUIRED_ROLES).toContain("principal-coder");
    expect(DEFAULT_PROMPTS["principal-coder"]).toBeDefined();
    expect(DEFAULT_PROMPTS["principal-coder"].length).toBeGreaterThan(0);
  });
  it("DEFAULT_COUNCILORS ≥1 üye; name+perspective dolu", () => {
    expect(DEFAULT_COUNCILORS.length).toBeGreaterThan(0);
    for (const c of DEFAULT_COUNCILORS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.perspective.length).toBeGreaterThan(0);
    }
  });
});
