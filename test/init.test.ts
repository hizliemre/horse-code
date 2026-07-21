import { describe, it, expect } from "vitest";
import { runInit, type InitIO } from "../src/init.js";

function mkIO(answers: string[], existing?: string) {
  let i = 0;
  const writes: { path: string; content: string }[] = [];
  const logs: string[] = [];
  const io: InitIO = {
    read: async () => answers[i++] ?? "",
    readFile: () => existing,
    writeFile: (path, content) => { writes.push({ path, content }); },
    home: "/home/u",
    log: (s) => { logs.push(s); },
  };
  return { io, writes, logs };
}

describe("runInit", () => {
  it("empty baseUrl → default; apiKey is written", async () => {
    const { io, writes } = mkIO(["", "secret-key"]);
    await runInit(io);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/home/u/.horsecode/config.json");
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.baseUrl).toBe("http://localhost:20128");
    expect(cfg.model).toBe("auto/best-coding");
    expect(cfg.apiKey).toBe("secret-key");
  });

  it("the entered baseUrl is used; empty apiKey → no apiKey", async () => {
    const { io, writes } = mkIO(["https://gw.example/v", "  "]);
    await runInit(io);
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.baseUrl).toBe("https://gw.example/v");
    expect("apiKey" in cfg).toBe(false);
  });

  it("preserves existing fields; keeps the existing model; empty apiKey clears the previous one", async () => {
    const existing = JSON.stringify({ mode: "auto", model: "openai/gpt-4o", apiKey: "old", roles: { coder: { models: ["x"] } } });
    const { io, writes } = mkIO(["", ""], existing);
    await runInit(io);
    const cfg = JSON.parse(writes[0].content);
    expect(cfg.mode).toBe("auto");
    expect(cfg.roles).toEqual({ coder: { models: ["x"] } });
    expect(cfg.model).toBe("openai/gpt-4o");
    expect("apiKey" in cfg).toBe(false);
  });

  it("the apiKey value is not written to the log", async () => {
    const { io, logs } = mkIO(["", "TOPSECRET"]);
    await runInit(io);
    expect(logs.join("\n")).not.toContain("TOPSECRET");
    expect(logs.join("\n")).toContain("apiKey: set");
  });
});
