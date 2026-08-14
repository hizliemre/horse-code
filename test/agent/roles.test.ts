import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RoleRegistry, runRole } from "../../src/agent/roles.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent } from "../../src/core/types.js";
import { SkillRegistry } from "../../src/skills/registry.js";

describe("RoleRegistry.resolve", () => {
  it("returns the primary + fallback chain, strict priority (no round-robin)", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b", "c"], systemPrompt: "p" } });
    const r = reg.resolve("coder");
    expect(r.model).toBe("a"); // primary = chain head
    expect(r.fallbacks).toEqual(["b", "c"]); // the rest are ordered fallbacks
    expect(reg.resolve("coder").model).toBe("a"); // resolving again does NOT advance — primary stays primary
  });

  it("markExhausted skips spent models in the chain, and never strands", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b", "c"], systemPrompt: "p" } });
    reg.markExhausted("a");
    expect(reg.resolve("coder")).toMatchObject({ model: "b", fallbacks: ["c"] }); // a dropped
    reg.markExhausted("b");
    reg.markExhausted("c");
    expect(reg.resolve("coder").model).toBe("a"); // whole chain spent → fall back to the raw chain
  });

  it("prompt priority: config > default", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["a"], systemPrompt: "cfg" }, analyst: { models: ["a"] } },
      { coder: "def", analyst: "def-analyst" },
    );
    expect(reg.resolve("coder").systemPrompt).toBe("cfg");
    expect(reg.resolve("analyst").systemPrompt).toBe("def-analyst");
  });

  it("undefined role / empty models / missing prompt → error", () => {
    const reg = new RoleRegistry({ x: { models: [] }, y: { models: ["a"] } });
    expect(() => reg.resolve("missing")).toThrow(/undefined role/);
    expect(() => reg.resolve("x")).toThrow(/model/);
    expect(() => reg.resolve("y")).toThrow(/systemPrompt/);
  });
});

describe("runRole", () => {
  it("resolves and runs runRoleAgent with the primary model", async () => {
    const reg = new RoleRegistry({ coder: { models: ["m1", "m2"], systemPrompt: "sp" } });
    const provider = new MockProvider([
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const input = {
      tools: new ToolRegistry(),
      messages: [{ role: "user" as const, content: "hi" }],
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      cwd: "/tmp",
      signal: new AbortController().signal,
    };
    const out: AgentEvent[] = [];
    for await (const ev of runRole(reg, provider, "coder", input)) out.push(ev);
    expect(out.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "ok" } });
    // the resolved model was used in the first request
    expect(provider.requests[0].model).toBe("m1");
  });
});

describe("RoleRegistry + skills", () => {
  it("when skillRegistry exists, mandatory skill + listing are injected into systemPrompt", () => {
    const skills = new SkillRegistry();
    skills.register({ name: "tdd", description: "TDD flow", content: "write tests first" });
    const reg = new RoleRegistry(
      { coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } },
      {},
      skills,
    );
    const { systemPrompt } = reg.resolve("coder");
    expect(systemPrompt).toContain("BASE");
    expect(systemPrompt).toContain("write tests first");
    // tdd is a mandatory skill, so it should not appear again in the discoverable listing
    expect(systemPrompt).not.toContain("- tdd: TDD flow");
  });

  it("when there is no skillRegistry, systemPrompt is unchanged", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } });
    expect(reg.resolve("coder").systemPrompt).toBe("BASE");
  });

  it("undefined mandatory skill → error message contains the role name", () => {
    const skills = new SkillRegistry();
    const reg = new RoleRegistry(
      { coder: { models: ["m"], systemPrompt: "BASE", skills: ["missing"] } },
      {},
      skills,
    );
    expect(() => reg.resolve("coder")).toThrow(/coder/);
    expect(() => reg.resolve("coder")).toThrow(/undefined skill/);
  });
});

describe("RoleRegistry.setModelOverride", () => {
  it("overrides work roles but NOT the refiner; clears on undefined/empty; systemPrompt unchanged", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["m1"] }, coach: { models: ["m2"] }, refiner: { models: ["r1"] } },
      { coder: "P-coder", coach: "P-coach", refiner: "P-refiner" },
    );
    expect(reg.resolve("coder").model).toBe("m1");

    reg.setModelOverride("live/model");
    expect(reg.resolve("coder").model).toBe("live/model");
    expect(reg.resolve("coach").model).toBe("live/model");
    expect(reg.resolve("refiner").model).toBe("r1"); // refiner keeps its own configured model
    expect(reg.resolve("coder").systemPrompt).toBe("P-coder");

    reg.setModelOverride(undefined);
    expect(reg.resolve("coder").model).toBe("m1");

    reg.setModelOverride("");
    expect(reg.resolve("coach").model).toBe("m2"); // empty string clears
  });
});

describe("RoleRegistry.setRoleModel", () => {
  it("per-role override wins over the global override + config; applies to the refiner too; clears on empty", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["m1"] }, coach: { models: ["m2"] }, refiner: { models: ["r1"] } },
      { coder: "P-coder", coach: "P-coach", refiner: "P-refiner" },
    );
    reg.setModelOverride("live/global");
    reg.setRoleModel("coder", "special/coder");
    expect(reg.peekModel("coder")).toBe("special/coder"); // per-role beats global
    expect(reg.peekModel("coach")).toBe("live/global");   // still the global override
    reg.setRoleModel("refiner", "special/refiner");
    expect(reg.resolve("refiner").model).toBe("special/refiner"); // explicit per-role applies even to refiner
    reg.setRoleModel("coder", "");
    expect(reg.peekModel("coder")).toBe("live/global"); // cleared → falls back to global override
  });

  it("accepts a multi-model chain; resolve exposes primary + fallbacks", () => {
    const reg = new RoleRegistry({ coder: { models: ["m1"], systemPrompt: "p" } });
    reg.setRoleModel("coder", ["x/primary", "y/fb1", "z/fb2"]);
    const r = reg.resolve("coder");
    expect(r.model).toBe("x/primary");
    expect(r.fallbacks).toEqual(["y/fb1", "z/fb2"]);
  });

  /**
   * A role the config has never heard of is exactly the one that needs assigning, and it was the one case
   * assigning could not reach.
   *
   * `rawChain` bailed on an empty config chain BEFORE consulting the override, so a role added in a new
   * version — `tester` — stayed broken for the whole session however it was fixed. The error it raised named
   * three remedies and none of them worked: `/roles setmodel` and `/roles adjust` both write the override
   * that was being skipped, and `/model` writes the global one, skipped by the same line.
   */
  it("can assign a role the config never configured — that is what assigning is FOR", () => {
    const reg = new RoleRegistry({ tester: { models: [] } }, { tester: "P-tester" });
    expect(() => reg.resolve("tester")).toThrow(/no model defined/);

    reg.setRoleModel("tester", ["x/primary", "y/fb"]);
    const r = reg.resolve("tester");
    expect(r.model).toBe("x/primary");
    expect(r.fallbacks).toEqual(["y/fb"]);
  });

  it("lets the session model rescue an unconfigured role too — the error offers it", () => {
    const reg = new RoleRegistry({ tester: { models: [] } }, { tester: "P-tester" });
    reg.setModelOverride("live/global");
    expect(reg.resolve("tester").model).toBe("live/global");
  });

  /** …and a role nobody has assigned still says so, rather than borrowing another role's model. */
  it("still refuses a role with nothing assigned anywhere", () => {
    const reg = new RoleRegistry({ tester: { models: [] }, coder: { models: ["m1"] } }, { tester: "P" });
    expect(() => reg.resolve("tester")).toThrow(/no model defined/);
  });
});

describe("RoleRegistry.setRules", () => {
  it("appends durable rules to EVERY role's resolved system prompt; ruleSuffix is empty with no rules", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "BASE" }, analyst: { models: ["m"] } }, { analyst: "A" });
    expect(reg.ruleSuffix()).toBe(""); // no rules yet
    expect(reg.resolve("coder").systemPrompt).toBe("BASE");
    reg.setRules(() => ["always answer in Turkish", "code comments in English"]);
    for (const role of ["coder", "analyst"]) {
      const sp = reg.resolve(role).systemPrompt;
      expect(sp).toContain("User rules (ALWAYS honor these)");
      expect(sp).toContain("- always answer in Turkish");
      expect(sp).toContain("- code comments in English");
    }
  });
});

// Five implementers in one wave are all the role `coder`, so every one of them resolved to the SAME chain head
// and hammered a single subscription until it rate-limited (observed: 5/5 on cx/gpt-5.6-sol-ultra).
describe("RoleRegistry.chainFor — parallel workers spread across the chain", () => {
  const r = () => new RoleRegistry({ coder: { models: ["a/m1", "b/m2", "c/m3"], systemPrompt: "P" } });

  it("each slot leads with a different model", () => {
    const reg = r();
    expect(reg.chainFor("coder", 0)[0]).toBe("a/m1");
    expect(reg.chainFor("coder", 1)[0]).toBe("b/m2");
    expect(reg.chainFor("coder", 2)[0]).toBe("c/m3");
  });

  // Rotation, not truncation: spreading the load must not cost a worker its fallbacks.
  it("every worker keeps the FULL chain, just in a different order", () => {
    const reg = r();
    for (const slot of [0, 1, 2, 7]) {
      expect([...reg.chainFor("coder", slot)].sort()).toEqual(["a/m1", "b/m2", "c/m3"]);
    }
  });

  it("wraps around when there are more workers than models", () => {
    expect(r().chainFor("coder", 4)[0]).toBe("b/m2"); // 4 % 3 = 1
  });

  it("slot 0 is exactly the plain chain (sequential callers are unchanged)", () => {
    const reg = r();
    expect(reg.chainFor("coder")).toEqual(reg.chain("coder"));
  });

  it("a quarantined model drops out of the rotation too", () => {
    const reg = r();
    reg.markExhausted("b/m2", "429");
    expect(reg.chainFor("coder", 0)[0]).toBe("a/m1");
    expect(reg.chainFor("coder", 1)[0]).toBe("c/m3"); // not the dead one
  });

  it("a single-model role is unaffected", () => {
    const one = new RoleRegistry({ coder: { models: ["a/m1"], systemPrompt: "P" } });
    expect(one.chainFor("coder", 3)).toEqual(["a/m1"]);
  });
});

// The message in the wild was "structured: previous model returned no valid result" — NOT a 429. The transport
// was fine, so nothing ever benched the model, and every role holding it slid past it on every single call.
describe("a model that will not produce structured output gets benched too", () => {
  const reg = (): RoleRegistry => new RoleRegistry({
    coach: { models: ["bad/m", "good/m"], systemPrompt: "P" },
    judge: { models: ["bad/m", "other/m"], systemPrompt: "P" },
  });

  it("one miss is tolerated — a single hard prompt is not a verdict on the model", () => {
    const r = reg();
    r.markStructuralFailure("bad/m", "prose");
    expect(r.isQuarantined("bad/m")).toBe(false);
  });

  it("a PATTERN benches it, with the real reason recorded", () => {
    const r = reg();
    for (let i = 0; i < RoleRegistry.STRUCTURAL_STRIKES; i++) r.markStructuralFailure("bad/m", "prose");
    expect(r.isQuarantined("bad/m")).toBe(true);
    expect(r.quarantined()[0].reason).toBe("prose");
    expect(r.chain("coach")).toEqual(["good/m"]); // and it drops out of the chain immediately
  });

  it("benching fires the hook ONCE, so every role still holding it can be re-assigned", () => {
    const r = reg();
    const benched: string[] = [];
    r.setOnQuarantine((m) => benched.push(m));
    for (let i = 0; i < RoleRegistry.STRUCTURAL_STRIKES + 3; i++) r.markStructuralFailure("bad/m", "prose");
    expect(benched).toEqual(["bad/m"]);
  });

  it("the hook also fires for an ordinary retryable exhaustion", () => {
    const r = reg();
    const benched: [string, string][] = [];
    r.setOnQuarantine((m, why) => benched.push([m, why]));
    r.markExhausted("bad/m", "429 rate limit");
    expect(benched).toEqual([["bad/m", "429 rate limit"]]);
  });

  it("releasing a model clears its strikes — its record described a state that has passed", () => {
    const r = reg();
    for (let i = 0; i < RoleRegistry.STRUCTURAL_STRIKES; i++) r.markStructuralFailure("bad/m", "prose");
    r.release("bad/m");
    r.markStructuralFailure("bad/m", "prose");
    expect(r.isQuarantined("bad/m")).toBe(false); // starts counting again from one
  });

  it("rolesUsing finds every role that must be moved off it", () => {
    expect(reg().rolesUsing("bad/m").sort()).toEqual(["coach", "judge"]);
  });
});

/**
 * A chain is only a list of names from a catalogue until something has watched the models work.
 *
 * Measured on a real board: two models were handed `coder` and `senior-coder` by the automatic
 * re-assignment — neither was in those chains, one was in no role at all — and answered the implementer in
 * prose 33 times without writing a file.
 */
describe("a role's chain skips what that role has proven it cannot use", () => {
  const reg = (): RoleRegistry => new RoleRegistry(
    { coder: { models: ["a/one", "b/two", "c/three"], systemPrompt: "p" },
      judge: { models: ["a/one"], systemPrompt: "p" } },
    {}, new SkillRegistry());

  it("drops an unfit model from that role's chain", () => {
    const r = reg();
    r.setFitness({ unfit: (role, m) => role === "coder" && m === "a/one" });
    expect(r.chain("coder")).toEqual(["b/two", "c/three"]);
  });

  /** Per-role, which is the point: the same model stays the judge's. */
  it("leaves every other role's chain alone", () => {
    const r = reg();
    r.setFitness({ unfit: (role, m) => role === "coder" && m === "a/one" });
    expect(r.chain("judge")).toEqual(["a/one"]);
  });

  /** A role with no model stops the run — worse than one that wastes an attempt and rotates. */
  it("never empties a chain", () => {
    const r = reg();
    r.setFitness({ unfit: () => true });
    expect(r.chain("coder")).toEqual(["a/one", "b/two", "c/three"]);
  });

  it("changes nothing when no record is wired", () => {
    expect(reg().chain("coder")).toEqual(["a/one", "b/two", "c/three"]);
  });
});

/**
 * How hard a role works travels with its chain, not with its prompt.
 *
 * Seven callers take the chain from `fallbackOpts` and supply their own prompt — the tester, the analyst,
 * the spec-kit phases — and they are the ones whose work is heaviest. A level that only rode on `resolve`
 * would miss exactly them.
 */
describe("a role's effort", () => {
  it("comes with the chain, so a caller that supplies its own prompt still gets it", () => {
    const reg = new RoleRegistry({ judge: { models: ["cc/claude-opus-5"], systemPrompt: "p", effort: "max" } });
    expect(reg.fallbackOpts("judge").effort).toBe("max");
    expect(reg.resolve("judge").effort).toBe("max");
  });

  it("is absent when the role has none — the field is then never sent, and the API's default stands", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "p" } });
    expect(reg.fallbackOpts("coder")).not.toHaveProperty("effort");
  });

  /** `/roles adjust` has to take effect in the session that ran it, not only in the next one. */
  it("can be set on the live registry, and the session's value wins over the config's", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "p", effort: "low" } });
    reg.setRoleEffort("coder", "xhigh");
    expect(reg.fallbackOpts("coder").effort).toBe("xhigh");
  });

  it("is removed when the role moves to a model whose effort cannot be set", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "p" } });
    reg.setRoleEffort("coder", "xhigh");
    reg.setRoleEffort("coder", undefined);
    expect(reg.fallbackOpts("coder")).not.toHaveProperty("effort");
  });
});
