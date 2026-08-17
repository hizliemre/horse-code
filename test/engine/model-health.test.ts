import { describe, it, expect } from "vitest";
import { ModelHealth } from "../../src/engine/model-health.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import type { RoleConfig } from "../../src/config/config.js";

const reg = (roles: Record<string, RoleConfig>): RoleRegistry => new RoleRegistry(roles);

/** Two registries, mirroring the real split (main roles vs. review lenses) — a quarantine must span both. */
function setup(opts: { models?: string[]; probe?: (m: string) => Promise<boolean> } = {}) {
  const main = reg({
    coach: { models: ["dead-a", "dead-b"], systemPrompt: "P" },
    judge: { models: ["dead-a", "alive-1"], systemPrompt: "P" },
  });
  const lenses = reg({
    "code-security": { models: ["dead-a", "dead-b"], systemPrompt: "P" },
    "code-tests": { models: ["alive-1"], systemPrompt: "P" },
  });
  const notes: string[] = [];
  const health = new ModelHealth({
    port: {
      roles: () => [...main.names(), ...lenses.names()],
      registries: () => [main, lenses],
      registryFor: (r) => (main.names().includes(r) ? main : lenses),
    },
    listModels: async () => opts.models ?? ["dead-a", "dead-b", "alive-1", "alive-2", "alive-3"],
    ...(opts.probe ? { probe: opts.probe } : {}),
    note: (m) => notes.push(m),
    now: () => 1000,
  });
  return { main, lenses, health, notes };
}

describe("RoleRegistry quarantine", () => {
  it("records why and when a model was spent", () => {
    const r = reg({ coach: { models: ["m1"], systemPrompt: "P" } });
    r.markExhausted("m1", "429 rate limit", 500);
    expect(r.quarantined()).toEqual([{ model: "m1", at: 500, reason: "429 rate limit" }]);
    expect(r.isQuarantined("m1")).toBe(true);
  });

  it("keeps the FIRST reason — the original cause, not whatever failed last", () => {
    const r = reg({ coach: { models: ["m1"], systemPrompt: "P" } });
    r.markExhausted("m1", "429 rate limit", 500);
    r.markExhausted("m1", "connection reset", 900);
    expect(r.quarantined()[0].reason).toBe("429 rate limit");
  });

  it("skips a quarantined model in every chain, but never strands a role with nothing", () => {
    const r = reg({ coach: { models: ["m1", "m2"], systemPrompt: "P" } });
    r.markExhausted("m1", "429");
    expect(r.chain("coach")).toEqual(["m2"]);
    r.markExhausted("m2", "429");
    // Everything spent → better to retry a spent model than to have no model at all…
    expect(r.chain("coach")).toEqual(["m1", "m2"]);
    // …but the collapse is detectable, which is what triggers a replacement chain.
    expect(r.chainCollapsed("coach")).toBe(true);
  });

  it("rolesUsing finds every role still holding a model, override or config", () => {
    const r = reg({ a: { models: ["m1"], systemPrompt: "P" }, b: { models: ["m2"], systemPrompt: "P" } });
    expect(r.rolesUsing("m1")).toEqual(["a"]);
    r.setRoleModel("b", ["m1", "m3"]); // an override must be seen too, not just the config
    expect(r.rolesUsing("m1").sort()).toEqual(["a", "b"]);
  });

  it("release puts a model back in play", () => {
    const r = reg({ coach: { models: ["m1", "m2"], systemPrompt: "P" } });
    r.markExhausted("m1", "429");
    expect(r.release("m1")).toBe(true);
    expect(r.chain("coach")).toEqual(["m1", "m2"]);
  });
});

describe("ModelHealth.handleChainFailure", () => {
  it("quarantines the dead chain and hands the role a replacement built from healthy models", async () => {
    const { health, lenses } = setup();
    const fresh = await health.handleChainFailure("code-security", "429 quota exceeded");
    expect(fresh?.length).toBeGreaterThan(0);
    for (const m of fresh!) expect(["alive-1", "alive-2", "alive-3"]).toContain(m);
    expect(lenses.chain("code-security")).toEqual(fresh);
  });

  // The dead model usually sits in several other chains too; leaving them alone means they fail the same way
  // the moment they run, one role at a time, for the rest of the session.
  it("re-chains every OTHER role that was still holding the dead models", async () => {
    const { health, main } = setup();
    await health.handleChainFailure("code-security", "429");
    expect(main.rawChain("coach")).not.toContain("dead-a");
    expect(main.rawChain("coach")).not.toContain("dead-b");
    expect(main.rawChain("judge")).not.toContain("dead-a");
  });

  it("marks the models in EVERY registry, not just the failing role's own", async () => {
    const { health, main, lenses } = setup();
    await health.handleChainFailure("code-security", "429");
    expect(main.isQuarantined("dead-a")).toBe(true);
    expect(lenses.isQuarantined("dead-a")).toBe(true);
  });

  it("reports the quarantine so the user can see WHY a model disappeared", async () => {
    const { health, notes } = setup();
    await health.handleChainFailure("code-security", "429 quota exceeded");
    expect(notes.join("\n")).toMatch(/Quarantined/);
    expect(notes.join("\n")).toMatch(/429 quota exceeded/);
  });

  it("returns undefined when nothing healthy is left rather than handing back a dead chain", async () => {
    const { health, notes } = setup({ models: ["dead-a", "dead-b"] });
    expect(await health.handleChainFailure("code-security", "429")).toBeUndefined();
    expect(notes.join("\n")).toMatch(/No healthy model left/);
  });

  it("healthyModels never offers a quarantined model", async () => {
    const { health } = setup();
    await health.handleChainFailure("code-security", "429");
    expect(await health.healthyModels()).toEqual(["alive-1", "alive-2", "alive-3"]);
  });
});

describe("ModelHealth.refresh — a quota limit is temporary, not a life sentence", () => {
  it("releases models that answer again and keeps the ones that still fail", async () => {
    const recovered = new Set(["dead-a"]);
    const { health, main, lenses } = setup({ probe: async (m) => recovered.has(m) });
    await health.handleChainFailure("code-security", "429");
    expect(await health.refresh()).toEqual(["dead-a"]);
    expect(main.isQuarantined("dead-a")).toBe(false);
    expect(lenses.isQuarantined("dead-a")).toBe(false);
    expect(main.isQuarantined("dead-b")).toBe(true); // still down → stays out
  });

  it("a released model is offered again on the next assignment", async () => {
    const { health } = setup({ probe: async () => true });
    await health.handleChainFailure("code-security", "429");
    expect(await health.healthyModels()).not.toContain("dead-a");
    await health.refresh();
    expect(await health.healthyModels()).toContain("dead-a");
  });

  it("a probe that throws is treated as still-down, never as recovered", async () => {
    const { health } = setup({ probe: async () => { throw new Error("network"); } });
    await health.handleChainFailure("code-security", "429");
    expect(await health.refresh()).toEqual([]);
  });

  it("does nothing when no probe is wired (headless) — it must not silently release everything", async () => {
    const { health, main } = setup();
    await health.handleChainFailure("code-security", "429");
    expect(await health.refresh()).toEqual([]);
    expect(main.isQuarantined("dead-a")).toBe(true);
  });
});

// Only a TOTAL chain collapse used to trigger a re-assignment. A merely-degraded model therefore stayed at the
// head of a dozen chains and each of them slid past it on every call, forever.
describe("ModelHealth.watch — benching one model moves every role off it at once", () => {
  it("re-chains all affected roles the moment a model is benched, without any chain collapsing", async () => {
    const { health, main, lenses } = setup();
    health.watch();
    main.markExhausted("dead-a", "429 rate limit");
    await new Promise((r) => setTimeout(r, 5)); // the sweep is fire-and-forget
    expect(main.rawChain("coach")).not.toContain("dead-a");
    expect(main.rawChain("judge")).not.toContain("dead-a");
    expect(lenses.rawChain("code-security")).not.toContain("dead-a");
  });

  it("repeated structural failures reach the same sweep", async () => {
    const { health, main } = setup();
    health.watch();
    for (let i = 0; i < RoleRegistry.STRUCTURAL_STRIKES; i++) main.markStructuralFailure("dead-a", "prose");
    await new Promise((r) => setTimeout(r, 5));
    expect(main.rawChain("coach")).not.toContain("dead-a");
  });

  it("reports the bench so the user can see WHY a model vanished", async () => {
    const { health, main, notes } = setup();
    health.watch();
    main.markExhausted("dead-a", "429 rate limit");
    await new Promise((r) => setTimeout(r, 5));
    expect(notes.join("\n")).toMatch(/Benched/);
    expect(notes.join("\n")).toMatch(/429 rate limit/);
  });

  it("does nothing when no role was using the model", async () => {
    const { health, main, notes } = setup();
    health.watch();
    main.markExhausted("never-assigned", "429");
    await new Promise((r) => setTimeout(r, 5));
    expect(notes.join("\n")).not.toMatch(/Benched/);
  });
});

/**
 * A busy transport is not a spent model.
 *
 * Measured live, mid-feature-run: `cc/claude-opus-5` served five calls in the preceding two minutes (23.8s,
 * 2.9s, 3.1s, 25.3s, 38.7s — all ok), then returned one 529 in 1.7 seconds. Eighteen roles were moved off the
 * best model in the fleet, and nothing in the system would have moved them back: the bench had no expiry, and
 * even with one, `sweep` writes per-role chain OVERRIDES that outlive the quarantine that caused them.
 *
 * The code already made this argument for behavioural benches — "a model that answered in prose is a
 * different case entirely: the transport was fine" — and never applied it to the transport itself.
 */
describe("how long a bench lasts", () => {
  it("benches a busy transport briefly, not for the session", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b"], systemPrompt: "p" } });
    const t0 = 1_000_000;
    reg.markExhausted("a", "Overloaded", t0);
    expect(reg.isQuarantined("a", t0 + 60_000)).toBe(true);
    expect(reg.isQuarantined("a", t0 + RoleRegistry.TRANSIENT_BENCH_MS + 1)).toBe(false);
  });

  it("keeps a spent subscription out until something re-probes it", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b"], systemPrompt: "p" } });
    const t0 = 1_000_000;
    reg.markExhausted("a", "429 rate limit exceeded", t0);
    expect(reg.isQuarantined("a", t0 + 24 * 3600_000)).toBe(true);
  });

  it("reads the difference from the reason it was given", async () => {
    const { isTransientFailure } = await import("../../src/agent/roles.js");
    for (const r of ["Overloaded", "529 overloaded_error", "the model did not answer within its deadline",
      "socket hang up", "ECONNRESET", "503 Service Unavailable", "temporarily unavailable",
      // A connection that dropped part-way through a tool call — see src/providers/omniroute.ts.
      "the stream ended in the middle of write_file's arguments"]) {
      expect(isTransientFailure(r), r).toBe(true);
    }
    for (const r of ["429 rate_limit_error", "quota exhausted", "insufficient credit",
      "All antigravity accounts have exhausted their quota (reset after 2h 1s)"]) {
      expect(isTransientFailure(r), r).toBe(false);
    }
  });

  /** Anything unrecognised keeps the model out: handing work to one that cannot take it is the worse error. */
  it("treats a reason it cannot read as permanent", async () => {
    const { isTransientFailure } = await import("../../src/agent/roles.js");
    expect(isTransientFailure("something nobody has seen before")).toBe(false);
  });
});

/**
 * A timed bench on its own changes nothing.
 *
 * `sweep` writes a per-role chain OVERRIDE, and an override outlives the quarantine that caused it. Measured
 * live: one 529 moved 18 roles off the best model in the fleet, and nothing would have moved them back even
 * after the model recovered — the only thing that ever did was a manual `/roles adjust`.
 */
describe("when a bench lapses", () => {
  it("puts the roles it moved back on the model", async () => {
    const { health, main } = setup();
    health.watch();
    const was = [...main.rawChain("coach")];
    expect(was).toContain("dead-a");
    main.markExhausted("dead-a", "Overloaded", Date.now(), Date.now() + 30);
    await new Promise((r) => setTimeout(r, 5));
    expect(main.rawChain("coach")).not.toContain("dead-a");   // moved off…
    await new Promise((r) => setTimeout(r, 60));
    expect(main.rawChain("coach")).toEqual(was);              // …and put back when the bench lapsed
  });

  it("leaves a role alone if something deliberate moved it since", async () => {
    const { health, main } = setup();
    health.watch();
    main.markExhausted("dead-a", "Overloaded", Date.now(), Date.now() + 30);
    await new Promise((r) => setTimeout(r, 5));
    main.setRoleModel("coach", ["chosen-on-purpose"]);        // /roles setmodel, mid-bench
    await new Promise((r) => setTimeout(r, 60));
    expect(main.rawChain("coach")).toEqual(["chosen-on-purpose"]);
  });

  it("says so, so a model reappearing is not a mystery", async () => {
    const { health, main, notes } = setup();
    health.watch();
    main.markExhausted("dead-a", "Overloaded", Date.now(), Date.now() + 30);
    await new Promise((r) => setTimeout(r, 70));
    expect(notes.join("\n")).toMatch(/Back in service/);
  });
});
