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
    ? { router: { models: ["m"], systemPrompt: "route et" } }
    : {};
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
  };
}

describe("routeTask", () => {
  it("router 'designer' derse designer döner", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p), card("buton tasarımı"))).toBe("designer");
  });
  it("router submit üretmezse coder fallback", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "?" }, { type: "done", finishReason: "stop" }]]);
    expect(await routeTask(deps(p), card("x"))).toBe("coder");
  });
  it("router role tanımsızsa coder fallback", async () => {
    const p = new MockProvider([submitTurn('{"role":"designer"}')]);
    expect(await routeTask(deps(p, false), card("x"))).toBe("coder");
  });
  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"role":"coder"}')]);
    await expect(routeTask(deps(p, true, ac.signal), card("x"))).rejects.toThrow();
  });
});
