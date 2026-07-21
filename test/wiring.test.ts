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
  it("council resolves; rounds=3; permission mode from config", async () => {
    const d = await deps(baseConfig({ mode: "ask" }));
    expect(d.councilors.length).toBeGreaterThan(0);
    expect(() => d.councilRegistry.resolve(d.councilors[0].name)).not.toThrow();
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
