import { describe, it, expect } from "vitest";
import { runRefiner, routeIntent, RefinerSchema } from "../../src/engine/refiner.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function deps(provider: MockProvider, skillRegistry = new SkillRegistry(), signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = { refiner: { models: ["m"], systemPrompt: "refine it" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, skillRegistry),
    skillRegistry,
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
  };
}

describe("routeIntent", () => {
  it("chat → chat; feature/bugfix → pipeline", () => {
    expect(routeIntent("chat")).toBe("chat");
    expect(routeIntent("feature")).toBe("pipeline");
    expect(routeIntent("bugfix")).toBe("pipeline");
  });
});

describe("runRefiner", () => {
  it("refines the prompt + produces intent", async () => {
    const p = new MockProvider([submit('{"refinedPrompt":"Do X","intent":"feature"}')]);
    const out = await runRefiner(deps(p), "can you do x");
    expect(out.intent).toBe("feature");
    expect(out.refinedPrompt).toBe("Do X");
  });

  it("if skill listing is added, the skill tool is in the toolset (E-skills coupling)", async () => {
    const sr = new SkillRegistry();
    sr.register({ name: "tdd", description: "TDD", content: "TDD content" });
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await runRefiner(deps(p, sr), "x");
    expect(p.requests[0].tools.map((t) => t.name)).toContain("skill");
  });

  it("throws if cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await expect(runRefiner(deps(p, new SkillRegistry(), ac.signal), "x")).rejects.toThrow();
  });
});

describe("routeIntent — what a request costs is not a judgement call", () => {
  /**
   * The odd one out: the other four all mean "produce something". A request to reverse the previous turn
   * operates ON that turn, and forcing it into a produce-something bucket is how "undo your change, go back
   * to the previous version" became a third rewrite of the same document.
   */
  it("routes an undo to its own path, never to a pipeline", () => {
    expect(routeIntent("undo")).toBe("undo");
  });

  it("routes governance work away from the pipeline entirely", () => {
    expect(routeIntent("govern")).toBe("govern");
    expect(routeIntent("chat")).toBe("chat");
    expect(routeIntent("feature")).toBe("pipeline");
    expect(routeIntent("bugfix")).toBe("pipeline");
  });

  /**
   * The refiner is told to judge by what the request PRODUCES. A request that mentions the constitution but
   * changes source code is still feature work, and one that mentions no code but rewrites the project's own
   * rules is not.
   */
  it("accepts govern as a classification the model may return", () => {
    expect(RefinerSchema.safeParse({ refinedPrompt: "Write the project constitution from CLAUDE.md", intent: "govern" }).success).toBe(true);
    expect(RefinerSchema.safeParse({ refinedPrompt: "Revert your last change", intent: "undo" }).success).toBe(true);
    expect(RefinerSchema.safeParse({ refinedPrompt: "x", intent: "governance" }).success).toBe(false);
  });
});
