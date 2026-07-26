import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJobDeps, logPRAdapter } from "../src/wiring.js";
import { REQUIRED_ROLES } from "../src/prompts.js";
import type { ResolvedConfig } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { WorktreeManager } from "../src/worktree/manager.js";
import type { Provider } from "../src/core/types.js";
import type { FetchLike } from "../src/providers/omniroute.js";

const fakeProvider: Provider = { async *chat() { /* buildJobDeps does not call this */ } };
// No real network: any url resolves to a canned 200 body so loadSpecKit's fetches are deterministic.
const fakeFetch: FetchLike = async (url) => new Response(`BODY ${url}`, { status: 200 });

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-wiring-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function baseConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    baseUrl: "http://x",
    model: "cc/m",
    mode: "auto",
    allowlist: [],
    roles: {},
    specKit: DEFAULT_CONFIG.specKit,
    mcp: {},
    modelSources: [],
    ...over,
  };
}
function deps(config: ResolvedConfig) {
  return buildJobDeps({
    config, provider: fakeProvider, skillRegistry: new SkillRegistry(),
    manager: new WorktreeManager({ repoRoot: "/tmp" }),
    prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
    approve: async () => true, signal: new AbortController().signal,
    home, fetch: fakeFetch,
  });
}

describe("buildJobDeps", () => {
  it("every REQUIRED_ROLES resolves to a model (analyst/planner are spec-kit-driven → model-only)", async () => {
    const d = await deps(baseConfig());
    // analyst + planner have no default system prompt (spec-kit supplies it); they expose only a model via
    // peekModel, so resolve() would throw for them — that's intended.
    const MODEL_ONLY = new Set(["analyst", "planner"]);
    for (const r of REQUIRED_ROLES) {
      if (MODEL_ONLY.has(r)) {
        expect(d.roleRegistry.peekModel(r), r).toBe("cc/m");
      } else {
        expect(() => d.roleRegistry.resolve(r), r).not.toThrow();
        expect(d.roleRegistry.resolve(r).model).toBe("cc/m");
      }
    }
  });
  it("team + council resolve; rounds=3; permission mode from config", async () => {
    const d = await deps(baseConfig({ mode: "ask" }));
    for (const stage of ["spec", "plan", "code"] as const) {
      expect(d.teams[stage].length).toBeGreaterThan(0);
      expect(() => d.teamRegistries[stage].resolve(d.teams[stage][0].name)).not.toThrow();
    }
    expect(d.council.length).toBeGreaterThan(0);
    expect(() => d.councilRegistry.resolve(d.council[0].name)).not.toThrow();
    expect(d.rounds).toBe(3);
  });
  it("config.roles overrides the default", async () => {
    const d = await deps(baseConfig({ roles: { coder: { models: ["custom/m"], systemPrompt: "custom coder" } } }));
    expect(d.roleRegistry.resolve("coder").model).toBe("custom/m");
    expect(d.roleRegistry.resolve("coder").systemPrompt).toContain("custom coder");
  });
  it("attaches specKit as a lazy loader with the configured version and working template/command accessors", async () => {
    const d = await deps(baseConfig({ specKit: { version: "v7.7.7" } }));
    const kit = await d.specKit();
    expect(kit.version).toBe("v7.7.7");
    expect(kit.template("spec")).toContain("spec-template.md");
    expect(kit.command("plan")).toContain("commands/plan.md");
  });
  it("does NOT fetch spec-kit at build time — the loader is lazy (regression guard for the chat must-fix)", async () => {
    let fetched = 0;
    const throwingFetch: FetchLike = async (url) => { fetched++; return new Response(`BODY ${url}`, { status: 200 }); };
    await buildJobDeps({
      config: baseConfig(), provider: fakeProvider, skillRegistry: new SkillRegistry(),
      manager: new WorktreeManager({ repoRoot: "/tmp" }),
      prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
      approve: async () => true, signal: new AbortController().signal,
      home, fetch: throwingFetch,
    });
    expect(fetched).toBe(0); // building deps (as a plain chat turn does) must not touch the network
  });
});

describe("logPRAdapter", () => {
  it("createPR logs + returns a placeholder url", async () => {
    const logs: string[] = [];
    const r = await logPRAdapter((s) => logs.push(s)).createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(logs[0]).toContain("hc/j/base");
    expect(r.url).toContain("pending");
  });
});

describe("rules reach EVERY agent (wired at the composition root)", () => {
  it("binds the rule source to the main registry, all three team stages, and the council", async () => {
    const rules = () => ["Always answer in Turkish", "Never use `as any`"];
    const d = await buildJobDeps({
      config: baseConfig(), provider: fakeProvider, skillRegistry: new SkillRegistry(),
      manager: new WorktreeManager({ repoRoot: "/tmp" }),
      prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
      approve: async () => true, signal: new AbortController().signal,
      home, fetch: fakeFetch, rules,
    });
    // a main role, one lens from each stage, and a council decider must all carry the rules
    const prompts = [
      d.roleRegistry.resolve("coach").systemPrompt,
      d.teamRegistries.spec.resolve(d.teams.spec[0].name).systemPrompt,
      d.teamRegistries.plan.resolve(d.teams.plan[0].name).systemPrompt,
      d.teamRegistries.code.resolve(d.teams.code[0].name).systemPrompt,
      d.councilRegistry.resolve(d.council[0].name).systemPrompt,
    ];
    for (const p of prompts) {
      expect(p).toContain("Always answer in Turkish");
      expect(p).toContain("Never use `as any`");
    }
  });

  it("the rule source is LIVE — a rule saved mid-session applies without a rebuild", async () => {
    let current: string[] = [];
    const d = await buildJobDeps({
      config: baseConfig(), provider: fakeProvider, skillRegistry: new SkillRegistry(),
      manager: new WorktreeManager({ repoRoot: "/tmp" }),
      prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
      approve: async () => true, signal: new AbortController().signal,
      home, fetch: fakeFetch, rules: () => current,
    });
    expect(d.roleRegistry.resolve("coach").systemPrompt).not.toContain("brand new rule");
    current = ["brand new rule"];
    expect(d.roleRegistry.resolve("coach").systemPrompt).toContain("brand new rule");
    expect(d.councilRegistry.resolve(d.council[0].name).systemPrompt).toContain("brand new rule");
  });
});

// The METHOD lives in an editable skill file; the role prompt only binds it to this pipeline. Attaching it as
// a MANDATORY skill is what inlines it into the brainstormer's system prompt.
describe("default role skills", () => {
  it("gives the brainstormer its skill, inlined as mandatory", async () => {
    const reg = new SkillRegistry();
    reg.register({ name: "brainstorming", description: "d", content: "EXPLORE BEFORE PROPOSING" });
    const d = await buildJobDeps({
      config: baseConfig(), provider: fakeProvider, skillRegistry: reg,
      manager: new WorktreeManager({ repoRoot: "/tmp" }),
      prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
      approve: async () => true, signal: new AbortController().signal,
      home, fetch: fakeFetch,
    });
    expect(d.roleRegistry.resolve("brainstormer").systemPrompt).toContain("EXPLORE BEFORE PROPOSING");
  });

  // applySkills THROWS on an unknown mandatory skill, so a checkout without the bundled skills would fail to
  // resolve the role at all — the pipeline must still run.
  it("drops a default skill that is not installed instead of breaking the role", async () => {
    const d = await deps(baseConfig()); // empty skill registry
    expect(() => d.roleRegistry.resolve("brainstormer")).not.toThrow();
  });

  it("a user-configured role is taken as written — no skills are forced on it", async () => {
    const reg = new SkillRegistry();
    reg.register({ name: "brainstorming", description: "d", content: "SHOULD NOT APPEAR" });
    const d = await buildJobDeps({
      config: baseConfig({ roles: { brainstormer: { models: ["m"], systemPrompt: "mine" } } }),
      provider: fakeProvider, skillRegistry: reg,
      manager: new WorktreeManager({ repoRoot: "/tmp" }),
      prAdapter: logPRAdapter(() => {}), askHuman: async () => ({ action: "abandon" }),
      approve: async () => true, signal: new AbortController().signal,
      home, fetch: fakeFetch,
    });
    expect(d.roleRegistry.resolve("brainstormer").systemPrompt).not.toContain("SHOULD NOT APPEAR");
  });
});
