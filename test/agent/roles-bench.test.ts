import { describe, it, expect, vi } from "vitest";
import { RoleRegistry } from "../../src/agent/roles.js";
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
