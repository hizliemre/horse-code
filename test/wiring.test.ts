import { describe, it, expect } from "vitest";
import { buildJobDeps, logPRAdapter } from "../src/wiring.js";
import { REQUIRED_ROLES } from "../src/prompts.js";
import type { ResolvedConfig } from "../src/config/config.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { WorktreeManager } from "../src/worktree/manager.js";
import type { Provider } from "../src/core/types.js";

const fakeProvider: Provider = { async *chat() { /* buildJobDeps çağırmaz */ } };
function baseConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { baseUrl: "http://x", model: "cc/m", mode: "auto", allowlist: [], roles: {}, ...over };
}
function deps(config: ResolvedConfig) {
  return buildJobDeps({
    config, provider: fakeProvider, skillRegistry: new SkillRegistry(),
    manager: new WorktreeManager({ repoRoot: "/tmp" }),
    prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
    approve: async () => true, signal: new AbortController().signal,
  });
}

describe("buildJobDeps", () => {
  it("her REQUIRED_ROLES resolve olur (config'te olmasa bile)", () => {
    const d = deps(baseConfig());
    for (const r of REQUIRED_ROLES) {
      expect(() => d.roleRegistry.resolve(r), r).not.toThrow();
      expect(d.roleRegistry.resolve(r).model).toBe("cc/m");
    }
  });
  it("council resolve olur; rounds=3; permission mode config'ten", () => {
    const d = deps(baseConfig({ mode: "ask" }));
    expect(d.councilors.length).toBeGreaterThan(0);
    expect(() => d.councilRegistry.resolve(d.councilors[0].name)).not.toThrow();
    expect(d.rounds).toBe(3);
  });
  it("config.roles varsayılanı ezer", () => {
    const d = deps(baseConfig({ roles: { coder: { models: ["özel/m"], systemPrompt: "özel coder" } } }));
    expect(d.roleRegistry.resolve("coder").model).toBe("özel/m");
    expect(d.roleRegistry.resolve("coder").systemPrompt).toContain("özel coder");
  });
});

describe("logPRAdapter", () => {
  it("createPR loglar + placeholder url döner", async () => {
    const logs: string[] = [];
    const r = await logPRAdapter((s) => logs.push(s)).createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(logs[0]).toContain("hc/j/base");
    expect(r.url).toContain("pending");
  });
});
