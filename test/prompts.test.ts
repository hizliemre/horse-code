import { describe, it, expect } from "vitest";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, SPEC_TEAM, PLAN_TEAM, CODE_TEAM, DEFAULT_COUNCIL } from "../src/prompts.js";

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
  it("SPEC_TEAM has >=1 member; name+perspective are populated", () => {
    expect(SPEC_TEAM.length).toBeGreaterThan(0);
    for (const c of SPEC_TEAM) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.perspective.length).toBeGreaterThan(0);
    }
  });
});

describe("per-stage review lens sets", () => {
  it("spec/plan/code each have their own lenses, and every lens name is globally unique", () => {
    const all = [...SPEC_TEAM, ...PLAN_TEAM, ...CODE_TEAM, ...DEFAULT_COUNCIL].map((r) => r.name);
    expect(new Set(all).size).toBe(all.length); // names double as role names in /roles → must not collide
    for (const r of [...SPEC_TEAM, ...PLAN_TEAM, ...CODE_TEAM, ...DEFAULT_COUNCIL]) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.perspective.length).toBeGreaterThan(0);
    }
  });

  it("the SPEC set carries the scope/leak guards and NO implementation-only lenses", () => {
    const names = SPEC_TEAM.map((r) => r.name);
    expect(names).toContain("spec-scope");            // gold-plating guard
    expect(names).toContain("spec-abstraction-leak"); // keeps implementation detail out of the spec
    // Implementation questions belong to the plan stage, so the spec team must not carry those lenses.
    for (const n of ["spec-concurrency", "spec-performance", "spec-dependencies", "spec-observability"]) {
      expect(names).not.toContain(n);
    }
  });

  it("each stage chains to the previous one (traceability) and keeps a simplicity guard", () => {
    expect(PLAN_TEAM.map((r) => r.name)).toContain("plan-spec-conformance");
    expect(CODE_TEAM.map((r) => r.name)).toContain("code-plan-conformance");
    expect(PLAN_TEAM.map((r) => r.name)).toContain("plan-simplicity");
    expect(CODE_TEAM.map((r) => r.name)).toContain("code-simplicity");
  });
});

/**
 * The tester talks to the person watching, not only to the file.
 *
 * Its prompt sent every result into the report — "a living document, not something assembled at the end" —
 * and said nothing about the chat. So it did exactly that: a run gathered live API responses, database rows
 * and a Loki log line proving an event fired once and not twice, wrote all of it into the report, and told
 * the user nothing. On screen there was `Ran 12 calls · shell ×5, graph_find ×3…` and to learn whether the
 * scenario passed you had to open a file inside a worktree.
 *
 * Every other role that works for minutes at a time narrates: the implementer, the conflict resolver, the
 * coach, the reviser. The tester's `onSay` was wired all along (see verify.ts) — nothing was ever asked of it.
 */
describe("the tester's prompt", () => {
  const tester = DEFAULT_PROMPTS.tester ?? "";

  it("asks for the verdict out loud, as it is reached", () => {
    expect(tester).toMatch(/OUT LOUD/);
    expect(tester).toMatch(/as you reach it/i);
  });

  it("asks for the one piece of evidence that settled it, not the whole record", () => {
    expect(tester).toMatch(/single piece of evidence/i);
    expect(tester).toMatch(/one or two sentences/i);
  });

  it("keeps the report as the place the full evidence lives", () => {
    expect(tester).toMatch(/full evidence still goes in the report/i);
    // …and the older instruction it qualifies is still there, or the report would stop being written.
    expect(tester).toMatch(/BEFORE moving on to the next scenario/);
  });

  it("covers the results a silent run hides best — failures and the ones never run", () => {
    expect(tester).toMatch(/NOT EXECUTED ones the same way/i);
  });

  /**
   * A 201 is not evidence that anything was stored.
   *
   * Measured live: a step-media scenario was exercised, the HTTP statuses and the screen were reported in
   * chat, and the report kept the scenario at PENDING with no row and no log line behind it. The same run
   * queried Loki once — for its label list, to check it was alive — and the database not at all, while the
   * DB and log evidence already in the report belonged to an earlier scenario from an earlier run.
   */
  it("refuses a stored-state claim that rests on the response alone", () => {
    expect(tester).toMatch(/THE RESPONSE IS NOT THE EVIDENCE/);
    expect(tester).toMatch(/query the database for that row/i);
    expect(tester).toMatch(/query the logs for the event/i);
  });

  it("asks for the query AND what it returned, not a claim that it was checked", () => {
    expect(tester).toMatch(/the query AND the rows it returned/i);
    expect(tester).toMatch(/the query AND the line it returned/i);
  });

  it("treats an absent event as evidence too — the no-op case that is easiest to skip", () => {
    expect(tester).toMatch(/Absence is evidence/i);
    expect(tester).toMatch(/returning nothing/i);
  });

  it("says what happens without it, so the rule has a consequence", () => {
    expect(tester).toMatch(/the scenario is NOT EXECUTED, however convincing/i);
  });
});
