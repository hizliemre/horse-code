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
import { fakeSpecKit } from "../support/fake-speckit.js";

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
  const roles: Record<string, RoleConfig> = { coach: { models: ["m"], systemPrompt: "be a coach" } };
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

describe("runCoachChat", () => {
  it("single turn: answers the prompt", async () => {
    const p = new MockProvider([textTurn("my answer")]);
    expect(await runCoachChat(deps(p), "hello", dir)).toBe("my answer");
  });

  it("reads with read-only tools and answers; write/shell not in the toolset", async () => {
    await writeFile(join(dir, "a.txt"), "content", "utf8");
    const p = new MockProvider([readTurn("a.txt"), textTurn("I read it and I'm answering")]);
    const out = await runCoachChat(deps(p), "what is a.txt", dir);
    expect(out).toBe("I read it and I'm answering");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });

  it("injects a relevant cross-session memory as a turn-context message", async () => {
    const p = new MockProvider([textTurn("ok")]);
    const d = {
      ...deps(p),
      memory: () => [{ id: "m1", text: "the parser lives in src/parser.ts", anchors: ["src/parser.ts"], tags: ["parser"], createdAt: 1 }],
    };
    await runCoachChat(d, "fix the bug in src/parser.ts", dir);
    const texts = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(texts).toContain("Relevant notes from earlier sessions");
    expect(texts).toContain("the parser lives in src/parser.ts");
  });

  it("does not inject memory when nothing is relevant to the prompt", async () => {
    const p = new MockProvider([textTurn("ok")]);
    const d = {
      ...deps(p),
      memory: () => [{ id: "m1", text: "unrelated note about cats", anchors: [], tags: ["cats"], createdAt: 1 }],
    };
    await runCoachChat(d, "how do I center a div", dir);
    const texts = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(texts).not.toContain("Relevant notes from earlier sessions");
  });

  it("injects context pins into the system prompt", async () => {
    const p = new MockProvider([textTurn("ok")]);
    const d = { ...deps(p), pins: () => ["use pnpm", "target Node 22"] };
    await runCoachChat(d, "hi", dir);
    const system = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("User pins");
    expect(system).toContain("- use pnpm");
    expect(system).toContain("- target Node 22");
  });

  it("ALWAYS injects rules (kind 'rule') into the system prompt, regardless of relevance", async () => {
    const p = new MockProvider([textTurn("ok")]);
    const d = {
      ...deps(p),
      memory: () => [
        { id: "r1", text: "always answer the user in Turkish", anchors: [], tags: ["lang"], createdAt: 1, kind: "rule" as const },
        { id: "m1", text: "unrelated note about cats", anchors: [], tags: ["cats"], createdAt: 1, kind: "fact" as const },
      ],
    };
    await runCoachChat(d, "build a widget", dir); // prompt unrelated to the rule → still injected
    const system = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("User rules (ALWAYS honor these)");
    expect(system).toContain("- always answer the user in Turkish");
    const allText = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(allText).not.toContain("cats"); // the unrelated FACT is not injected (relevance-gated), but the rule is
  });

  it("injects the model + the user's language into the system prompt when language is given", async () => {
    const p = new MockProvider([textTurn("cevabım")]);
    await runCoachChat(deps(p), "which model are you?", dir, [], "Turkish");
    const system = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain('powered by the "m" model');
    expect(system).toContain("Respond in Turkish.");
  });

  it("omits the language line when no language is given (still names the model)", async () => {
    const p = new MockProvider([textTurn("answer")]);
    await runCoachChat(deps(p), "hi", dir);
    const system = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain('powered by the "m" model');
    expect(system).not.toContain("Respond in");
  });

  it("throws if cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([textTurn("x")]);
    await expect(runCoachChat(deps(p, ac.signal), "x", dir)).rejects.toThrow();
  });
});
