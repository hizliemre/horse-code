import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RoleRegistry, runRole } from "../../src/agent/roles.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent } from "../../src/core/types.js";
import { SkillRegistry } from "../../src/skills/registry.js";

describe("RoleRegistry.resolve", () => {
  it("round-robin ile modeller arasında döner (role başına)", () => {
    const reg = new RoleRegistry({ coder: { models: ["a", "b"], systemPrompt: "p" } });
    expect(reg.resolve("coder").model).toBe("a");
    expect(reg.resolve("coder").model).toBe("b");
    expect(reg.resolve("coder").model).toBe("a");
  });

  it("prompt önceliği: config > default", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["a"], systemPrompt: "cfg" }, analyst: { models: ["a"] } },
      { coder: "def", analyst: "def-analyst" },
    );
    expect(reg.resolve("coder").systemPrompt).toBe("cfg");
    expect(reg.resolve("analyst").systemPrompt).toBe("def-analyst");
  });

  it("tanımsız role / boş models / prompt yok → hata", () => {
    const reg = new RoleRegistry({ x: { models: [] }, y: { models: ["a"] } });
    expect(() => reg.resolve("yok")).toThrow(/tanımsız role/);
    expect(() => reg.resolve("x")).toThrow(/model/);
    expect(() => reg.resolve("y")).toThrow(/systemPrompt/);
  });
});

describe("runRole", () => {
  it("resolve edip runRoleAgent'ı çalıştırır (round-robin tüketir)", async () => {
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
    // resolve edilen model ilk istekte kullanıldı
    expect(provider.requests[0].model).toBe("m1");
  });
});

describe("RoleRegistry + skills", () => {
  it("skillRegistry varsa zorunlu skill + listing systemPrompt'a enjekte edilir", () => {
    const skills = new SkillRegistry();
    skills.register({ name: "tdd", description: "TDD akışı", content: "önce test yaz" });
    const reg = new RoleRegistry(
      { coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } },
      {},
      skills,
    );
    const { systemPrompt } = reg.resolve("coder");
    expect(systemPrompt).toContain("BASE");
    expect(systemPrompt).toContain("önce test yaz");
    // tdd zorunlu skill olduğu için keşfedilebilir listing'de tekrar görünmemeli
    expect(systemPrompt).not.toContain("- tdd: TDD akışı");
  });

  it("skillRegistry yoksa systemPrompt değişmez", () => {
    const reg = new RoleRegistry({ coder: { models: ["m"], systemPrompt: "BASE", skills: ["tdd"] } });
    expect(reg.resolve("coder").systemPrompt).toBe("BASE");
  });

  it("tanımsız zorunlu skill → hata mesajı role adını içerir", () => {
    const skills = new SkillRegistry();
    const reg = new RoleRegistry(
      { coder: { models: ["m"], systemPrompt: "BASE", skills: ["yok"] } },
      {},
      skills,
    );
    expect(() => reg.resolve("coder")).toThrow(/coder/);
    expect(() => reg.resolve("coder")).toThrow(/tanımsız skill/);
  });
});
