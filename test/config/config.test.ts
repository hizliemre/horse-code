import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/config.js";

const noFiles = () => undefined;

describe("loadConfig", () => {
  it("returns defaults when no source is present", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: noFiles });
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.mode).toBe("acceptEdits"); // default: auto-approve file writes, still ask for commands
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.allowlist).toEqual([]);
  });

  it("global config values override the defaults", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ model: "gpt-x", apiKey: "sk-global", mode: "acceptEdits" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.apiKey).toBe("sk-global");
    expect(cfg.mode).toBe("acceptEdits");
  });

  it("project config overrides global but ignores apiKey", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ model: "global-model", apiKey: "sk-global" });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ model: "proj-model", apiKey: "sk-LEAK", allowlist: ["npm test"] });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("proj-model");
    expect(cfg.apiKey).toBe("sk-global"); // project apiKey was ignored
    expect(cfg.allowlist).toEqual(["npm test"]);
  });

  it("env variables have the highest priority", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ apiKey: "sk-global", baseUrl: "https://global" })
        : undefined;
    const cfg = loadConfig({
      cwd: "/proj",
      home: "/home",
      env: { OMNIROUTE_API_KEY: "sk-env", OMNIROUTE_BASE_URL: "https://env" },
      readFile,
    });
    expect(cfg.apiKey).toBe("sk-env");
    expect(cfg.baseUrl).toBe("https://env");
  });

  it("ignores that layer on malformed JSON, continues without crashing", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json" ? "{ malformed json" : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.mode).toBe("acceptEdits"); // fell back to default
  });

  it("project apiKey is fully ignored when global is absent (result undefined)", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ apiKey: "sk-LEAK", model: "proj-model" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe("proj-model");
  });

  it("global sets allowlist, stays global if project doesn't set one", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ allowlist: ["git status"] })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.allowlist).toEqual(["git status"]);
  });

  it("preserves other fields of that layer in valid JSON with an unknown key", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ model: "proj-model", unknownKey: "x" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("proj-model"); // since .strict() was removed, a typo doesn't drop the whole layer
  });

  it("default baseUrl is omniroute's local-first address", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.baseUrl).toBe("http://localhost:20128");
  });

  it("parses mcp servers (stdio + remote), merges global + project", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ mcp: { fs: { command: ["npx", "-y", "server-filesystem", "/x"] } } })
        : p === "/proj/.horsecode/config.json"
          ? JSON.stringify({ mcp: { gh: { url: "https://mcp.example.com", headers: { Authorization: "Bearer t" } } } })
          : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.mcp.fs).toEqual({ command: ["npx", "-y", "server-filesystem", "/x"] });
    expect(cfg.mcp.gh).toEqual({ url: "https://mcp.example.com", headers: { Authorization: "Bearer t" } });
  });

  it("drops an invalid mcp entry's layer but keeps default mcp = {}", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.mcp).toEqual({});
  });

  it("returns an empty object when there are no roles", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.roles).toEqual({});
  });

  it("merges global and project roles, same-named role is overridden by project", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ roles: { coder: { models: ["g-model"] }, refiner: { models: ["r"] } } });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ roles: { coder: { models: ["p-model"], systemPrompt: "proj" } } });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.roles.coder).toEqual({ models: ["p-model"], systemPrompt: "proj" });
    expect(cfg.roles.refiner).toEqual({ models: ["r"] });
  });

  it("loads the role skills field", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ roles: { coder: { models: ["m"], skills: ["tdd", "cs"] } } })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.roles.coder).toEqual({ models: ["m"], skills: ["tdd", "cs"] });
  });

  it("parses per-stage team sets and council.members", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({
            team: { spec: [{ name: "sec", perspective: "security", models: ["m1"] }] },
            council: { members: [{ name: "risk-judge", perspective: "risk", models: ["m2"] }] },
          })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.team?.spec?.[0]).toEqual({ name: "sec", perspective: "security", models: ["m1"] });
    expect(cfg.council?.members[0]).toEqual({ name: "risk-judge", perspective: "risk", models: ["m2"] });
  });

  it("per-stage team sets are independent — a project may override just one stage", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ team: { spec: [{ name: "g-spec", perspective: "s", models: ["m1"] }], plan: [{ name: "g-plan", perspective: "p", models: ["m1"] }] } });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ team: { spec: [{ name: "p-spec", perspective: "s2", models: ["m2"] }] } });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.team?.spec?.[0].name).toBe("p-spec"); // project wins for the stage it defines
    expect(cfg.team?.plan?.[0].name).toBe("g-plan"); // the other stage falls back to global
    expect(cfg.team?.code).toBeUndefined();          // undefined → wiring uses the built-in CODE_TEAM
  });

  it("team + council are undefined when the file configures neither", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.team).toBeUndefined();
    expect(cfg.council).toBeUndefined();
  });

  it("defaults specKit.version and reads it from a file", () => {
    const cfg = loadConfig({
      cwd: "/x", home: "/h", env: {},
      readFile: (p) => (p === "/h/.horsecode/config.json" ? '{"specKit":{"version":"v0.14.0"}}' : undefined),
    });
    expect(cfg.specKit.version).toBe("v0.14.0");
  });

  it("specKit falls back to the default version when absent", () => {
    const cfg = loadConfig({ cwd: "/x", home: "/h", env: {}, readFile: () => undefined });
    expect(cfg.specKit.version).toBe("v0.13.2");
  });
});

/**
 * Connected accounts, and the two ways this schema silently threw them away.
 *
 * Both were found by connecting a real z.ai account and noticing it never appeared on the start-up line. The
 * cause was not the panel: `loadConfig` had already dropped it, and dropped a great deal more with it.
 */
describe("the accounts a subscription writes here", () => {
  const withAccounts = (accounts: unknown) => (p: string) =>
    p === "/home/.horsecode/config.json"
      ? JSON.stringify({ apiKey: "sk-global", roles: { coder: { models: ["opus"] } }, accounts })
      : undefined;

  /**
   * The kinds were spelled out as `["claude", "codex"]` here while being declared in `CLI_KINDS`, so every
   * account of a kind added since was rejected on the way in.
   */
  it("accepts every CLI horse-code can connect", () => {
    const accounts = [
      { kind: "claude", name: "a@x.com", configDir: "/p/c" },
      { kind: "codex", name: "codex-2", configDir: "/p/x" },
      { kind: "grok", name: "grok-2", configDir: "/p/g" },
      { kind: "zai", name: "zai-2", configDir: "/p/z" },
    ];
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: withAccounts(accounts) });
    expect(cfg.accounts.map((a) => a.kind)).toEqual(["claude", "codex", "grok", "zai"]);
  });

  /**
   * The signed-in default is exactly the entry with NO directory — `withAmbient` records it that way on
   * purpose, because naming a directory switches Claude Code off its Keychain session. `configDir` was
   * required, so the one entry written to stop a second account quietly retiring the first was unloadable.
   */
  it("keeps the signed-in default, which has no directory at all", () => {
    const accounts = [{ kind: "claude", name: "a@x.com", email: "a@x.com", plan: "max" }];
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: withAccounts(accounts) });
    expect(cfg.accounts).toHaveLength(1);
    expect(cfg.accounts[0]).not.toHaveProperty("configDir");
  });

  /**
   * What a bad row may cost, and it used to be everything.
   *
   * The loader reads `parsed.success ? parsed.data : {}`, so one rejected account discarded the WHOLE global
   * config. Measured on a live one: 64 role chains and an API key, gone silently, for every session after a
   * z.ai account was connected. The blast radius is now the accounts list.
   */
  it("does not let one malformed account discard the whole config", () => {
    const cfg = loadConfig({
      cwd: "/proj", home: "/home", env: {},
      readFile: withAccounts([{ kind: "nonesuch", name: "x" }]),
    });
    expect(cfg.apiKey).toBe("sk-global");
    expect(Object.keys(cfg.roles)).toEqual(["coder"]);
    expect(cfg.accounts).toEqual([]);
  });
});
