import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RoleRegistry, runRole } from "../../src/agent/roles.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent } from "../../src/core/types.js";
import { SkillRegistry } from "../../src/skills/registry.js";

describe("RoleRegistry.resolve", () => {
  it("round-robins across models (per role)", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b"], systemPrompt: "p" } });
    expect(reg.resolve("coder").model).toBe("a");
    expect(reg.resolve("coder").model).toBe("b");
    expect(reg.resolve("coder").model).toBe("a");
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
  it("resolves and runs runRoleAgent (consumes round-robin)", async () => {
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
});
