import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/config.js";

const noFiles = () => undefined;

describe("loadConfig", () => {
  it("returns defaults when no source is present", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: noFiles });
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.mode).toBe("ask");
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
    expect(cfg.mode).toBe("ask"); // fell back to default
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

  it("parses council.councilors", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ council: { councilors: [{ name: "sec", perspective: "security", models: ["m1"] }] } })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.council?.councilors[0].name).toBe("sec");
    expect(cfg.council?.councilors[0].perspective).toBe("security");
    expect(cfg.council?.councilors[0].models).toEqual(["m1"]);
  });

  it("is undefined when there is no council", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.council).toBeUndefined();
  });
});
