import { describe, it, expect } from "vitest";
import { routeTask } from "../../src/engine/routing.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import type { RoleConfig } from "../../src/config/config.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const card = (title: string): Card => ({
  id: "t1", title, column: "TODO", deps: [], reviewNotes: [], attempts: 0, stageHistory: [],
});
function deps(provider: MockProvider, hasRouter = true, signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = hasRouter
    ? { router: { models: ["m"], systemPrompt: "route it" } }
    : {};
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
  };
}

describe("routeTask", () => {
  it("returns designer when the router says 'designer'", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p), card("button design"))).toBe("designer");
  });
  it("falls back to coder when the router doesn't produce a submit", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "?" }, { type: "done", finishReason: "stop" }]]);
    expect(await routeTask(deps(p), card("x"))).toBe("coder");
  });
  it("falls back to coder when the router role is undefined", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p, false), card("x"))).toBe("coder");
  });
  it("throws if cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"role":"coder"}')]);
    await expect(routeTask(deps(p, true, ac.signal), card("x"))).rejects.toThrow();
  });

  it("if the skill listing is added to the prompt, the skill tool must be in the toolset too (E-skills coupling)", async () => {
    const skillRegistry = new SkillRegistry();
    skillRegistry.register({ name: "tdd", description: "TDD", content: "TDD content" });
    const roles: Record<string, RoleConfig> = { router: { models: ["m"], systemPrompt: "route it" } };
    const p = new MockProvider([submitTurn('{"role":"coder"}')]);
    const d: TaskCycleDeps = {
      provider: p,
      roleRegistry: new RoleRegistry(roles, {}, skillRegistry),
      skillRegistry,
      permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
      approve: async () => true,
      signal: new AbortController().signal,
      specKit: fakeSpecKit,
    };
    await routeTask(d, card("x"));
    expect(p.requests[0].tools.map((t) => t.name)).toContain("skill");
  });
});
