import { describe, it, expect } from "vitest";
import { isUnknownModelError } from "../../src/providers/omniroute.js";
import { ModelHealth } from "../../src/engine/model-health.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import type { RoleConfig } from "../../src/config/config.js";

const REAL = "Unable to determine provider for model 'default'. Use a provider/model prefix (e.g. openai/default) or ensure the model exists.";

/**
 * One unresolvable model id took the whole pool down.
 *
 * A role holding the placeholder failed with "Unable to determine provider for model 'default'" — and that
 * error quarantined the three WORKING models the role had been assigned, then re-chained fifty-eight other
 * roles onto a pool that had just shrunk, which produced the next failure. Fifteen review lenses went down
 * in a row over an id none of them was using.
 */
describe("isUnknownModelError", () => {
  it("recognises the gateway's own wording", () => {
    expect(isUnknownModelError(REAL)).toBe(true);
    expect(isUnknownModelError("unknown model: foo/bar")).toBe(true);
    expect(isUnknownModelError("model not found")).toBe(true);
  });

  /** A rate limit or an outage IS about the model, and benching it is the right answer. */
  it("does not swallow a real health failure", () => {
    expect(isUnknownModelError("429 Too Many Requests")).toBe(false);
    expect(isUnknownModelError("upstream returned 503")).toBe(false);
    expect(isUnknownModelError("All antigravity accounts have exhausted their quota")).toBe(false);
  });
});

describe("a chain failure caused by a bad model id benches nothing", () => {
  const build = () => {
    const roles: Record<string, RoleConfig> = {
      "code-performance": { models: ["a/one", "b/two", "c/three"], systemPrompt: "p" },
      "code-simplicity": { models: ["a/one", "b/two"], systemPrompt: "p" },
    };
    const reg = new RoleRegistry(roles, {}, undefined as never);
    const notes: string[] = [];
    const health = new ModelHealth({
      port: {
        roles: () => ["code-performance", "code-simplicity"],
        registries: () => [reg],
        registryFor: () => reg,
      },
      listModels: async () => ["a/one", "b/two", "c/three", "d/four"],
      note: (m: string) => notes.push(m),
    } as never);
    return { reg, health, notes };
  };

  it("re-chains the role without quarantining the models it was on", async () => {
    const { reg, health, notes } = build();
    const chain = await health.handleChainFailure("code-performance", REAL);
    expect(chain?.length).toBeGreaterThan(0);
    for (const m of ["a/one", "b/two", "c/three"]) expect(reg.isQuarantined(m)).toBe(false);
    expect(notes.join("\n")).not.toMatch(/Quarantined/);
    expect(notes.join("\n")).toMatch(/no model was benched/);
  });

  /** The cascade's engine: every failure re-chained every other role holding those models. */
  it("does not drag the other roles through a reassignment", async () => {
    const { health, notes } = build();
    await health.handleChainFailure("code-performance", REAL);
    expect(notes.join("\n")).not.toMatch(/Re-assigned/);
  });

  it("still benches on a failure that IS about the model", async () => {
    const { reg, health, notes } = build();
    await health.handleChainFailure("code-performance", "429 Too Many Requests");
    expect(reg.isQuarantined("a/one")).toBe(true);
    expect(notes.join("\n")).toMatch(/Quarantined/);
  });
});
