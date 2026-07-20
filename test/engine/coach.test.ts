import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoachChat } from "../../src/engine/coach.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-coach-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const textTurn = (t: string): ChatEvent[] => [{ type: "text-delta", text: t }, { type: "done", finishReason: "stop" }];
function readTurn(path: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "r", name: "read_file", arguments: JSON.stringify({ path }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function deps(provider: MockProvider, signal?: AbortSignal): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = { coach: { models: ["m"], systemPrompt: "coach ol" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
  };
}

describe("runCoachChat", () => {
  it("tek-tur: prompt'u yanıtlar", async () => {
    const p = new MockProvider([textTurn("cevabım")]);
    expect(await runCoachChat(deps(p), "merhaba", dir)).toBe("cevabım");
  });

  it("salt-okunur tool'larla okuyup cevaplar; write/shell toolset'te yok", async () => {
    await writeFile(join(dir, "a.txt"), "içerik", "utf8");
    const p = new MockProvider([readTurn("a.txt"), textTurn("okudum ve cevaplıyorum")]);
    const out = await runCoachChat(deps(p), "a.txt nedir", dir);
    expect(out).toBe("okudum ve cevaplıyorum");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([textTurn("x")]);
    await expect(runCoachChat(deps(p, ac.signal), "x", dir)).rejects.toThrow();
  });
});
