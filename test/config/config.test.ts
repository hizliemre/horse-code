import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/config.js";

const noFiles = () => undefined;

describe("loadConfig", () => {
  it("hiçbir kaynak yoksa varsayılanları döner", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: noFiles });
    expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(cfg.mode).toBe("ask");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.allowlist).toEqual([]);
  });

  it("global config değerleri varsayılanı ezer", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ model: "gpt-x", apiKey: "sk-global", mode: "acceptEdits" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.apiKey).toBe("sk-global");
    expect(cfg.mode).toBe("acceptEdits");
  });

  it("proje config global'i ezer ama apiKey'i yok sayar", () => {
    const readFile = (p: string) => {
      if (p === "/home/.horsecode/config.json")
        return JSON.stringify({ model: "global-model", apiKey: "sk-global" });
      if (p === "/proj/.horsecode/config.json")
        return JSON.stringify({ model: "proj-model", apiKey: "sk-LEAK", allowlist: ["npm test"] });
      return undefined;
    };
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("proj-model");
    expect(cfg.apiKey).toBe("sk-global"); // proje apiKey'i yok sayıldı
    expect(cfg.allowlist).toEqual(["npm test"]);
  });

  it("env değişkenleri en yüksek önceliğe sahiptir", () => {
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

  it("bozuk JSON'da o katmanı yok sayar, çökmeden devam eder", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json" ? "{ bozuk json" : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.mode).toBe("ask"); // varsayılana düştü
  });

  it("global yokken proje apiKey'i tamamen yok sayılır (sonuç undefined)", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ apiKey: "sk-LEAK", model: "proj-model" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe("proj-model");
  });

  it("global allowlist ayarlar, proje ayarlamazsa global kalır", () => {
    const readFile = (p: string) =>
      p === "/home/.horsecode/config.json"
        ? JSON.stringify({ allowlist: ["git status"] })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.allowlist).toEqual(["git status"]);
  });

  it("bilinmeyen key'li geçerli JSON'da o katmanın diğer alanları korunur", () => {
    const readFile = (p: string) =>
      p === "/proj/.horsecode/config.json"
        ? JSON.stringify({ model: "proj-model", unknownKey: "x" })
        : undefined;
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile });
    expect(cfg.model).toBe("proj-model"); // .strict() kaldırıldığı için typo tüm katmanı düşürmez
  });

  it("varsayılan baseUrl omniroute local-first adresidir", () => {
    const cfg = loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: () => undefined });
    expect(cfg.baseUrl).toBe("http://localhost:20128");
  });
});
