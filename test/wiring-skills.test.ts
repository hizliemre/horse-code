import { describe, it, expect } from "vitest";
import { buildJobDeps } from "../src/wiring.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { ResolvedConfig } from "../src/config/config.js";

const registry = (): SkillRegistry => {
  const r = new SkillRegistry();
  for (const name of ["test-driven-development", "frontend-design", "writing-plans"]) {
    r.register({ name, description: `desc of ${name}`, content: `BODY-OF-${name}` });
  }
  return r;
};

/**
 * Only the role wiring is under test here. The collaborators buildJobDeps also takes (provider, worktree
 * manager, PR adapter, …) are never reached by resolving a role, so they are stubbed rather than constructed.
 */
const opts = (roles: ResolvedConfig["roles"]): Parameters<typeof buildJobDeps>[0] =>
  ({
    // A real session model: with the placeholder, a role with no configured chain is deliberately left
    // EMPTY (it is not a model id, and dispatching it fails), which is a different test's subject.
    config: { ...DEFAULT_CONFIG, model: "cc/claude-opus-4-8", roles },
    skillRegistry: registry(),
    home: "/tmp/hc-nowhere",
  }) as unknown as Parameters<typeof buildJobDeps>[0];

const build = async (roles: ResolvedConfig["roles"]) => {
  const deps = await buildJobDeps(opts(roles));
  // A skill reaches a role by being inlined into its system prompt — that rendered prompt is what the model
  // actually sees, so it is what this asserts on.
  return (role: string): string[] =>
    ["test-driven-development", "frontend-design", "writing-plans"]
      .filter((n) => deps.roleRegistry.resolve(role).systemPrompt.includes(`BODY-OF-${n}`));
};

describe("role skills survive a role being configured", () => {
  it("an unconfigured role gets its defaults", async () => {
    const skillsOf = await build({});
    expect(skillsOf("coder")).toContain("test-driven-development");
    expect(skillsOf("designer")).toContain("frontend-design");
  });

  // The regression this guards: `/roles adjust` persists `{models}` for EVERY role. Treating any configured
  // role as "written as intended" then dropped every default skill in the product on the first re-tune.
  it("configuring only the models does not unassign the skills", async () => {
    const skillsOf = await build({
      coder: { models: ["m1", "m2"] },
      designer: { models: ["m3"] },
    });
    expect(skillsOf("coder")).toContain("test-driven-development");
    expect(skillsOf("designer")).toContain("frontend-design");
  });

  // The bypass the user asked for: a project that writes no unit tests must not have its coding agents
  // inventing a test suite. Declaring the list empty is how you say that.
  it("an explicitly empty list means no skills, not 'use the defaults'", async () => {
    const skillsOf = await build({ coder: { models: ["m1"], skills: [] } });
    expect(skillsOf("coder")).toEqual([]);
  });

  it("a declared list replaces the defaults rather than adding to them", async () => {
    const skillsOf = await build({ coder: { models: ["m1"], skills: ["writing-plans"] } });
    expect(skillsOf("coder")).toEqual(["writing-plans"]);
  });

  it("leaves the other roles alone when one role opts out", async () => {
    const skillsOf = await build({ coder: { models: ["m1"], skills: [] } });
    expect(skillsOf("coder")).toEqual([]);
    expect(skillsOf("senior-coder")).toContain("test-driven-development");
  });

  it("a skill that is not installed is dropped, never fatal", async () => {
    const skillsOf = await build({ coder: { models: ["m1"], skills: ["writing-plans", "not-installed"] } });
    expect(skillsOf("coder")).toEqual(["writing-plans"]);
  });

  it("the configured models are still honoured", async () => {
    const deps = await buildJobDeps(opts({ coder: { models: ["m1", "m2"] } }));
    expect(deps.roleRegistry.rawChain("coder")).toEqual(["m1", "m2"]);
  });
});
