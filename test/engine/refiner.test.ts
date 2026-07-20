import { describe, it, expect } from "vitest";
import { runRefiner, routeIntent } from "../../src/engine/refiner.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function deps(provider: MockProvider, skillRegistry = new SkillRegistry(), signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = { refiner: { models: ["m"], systemPrompt: "refine et" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, skillRegistry),
    skillRegistry,
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
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
  it("prompt'u refine eder + intent üretir", async () => {
    const p = new MockProvider([submit('{"refinedPrompt":"X yap","intent":"feature"}')]);
    const out = await runRefiner(deps(p), "x yapabilir misin");
    expect(out.intent).toBe("feature");
    expect(out.refinedPrompt).toBe("X yap");
  });

  it("skill listing eklendiyse skill tool toolset'te (E-skills coupling)", async () => {
    const sr = new SkillRegistry();
    sr.register({ name: "tdd", description: "TDD", content: "TDD içeriği" });
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await runRefiner(deps(p, sr), "x");
    expect(p.requests[0].tools.map((t) => t.name)).toContain("skill");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"refinedPrompt":"x","intent":"chat"}')]);
    await expect(runRefiner(deps(p, new SkillRegistry(), ac.signal), "x")).rejects.toThrow();
  });
});
