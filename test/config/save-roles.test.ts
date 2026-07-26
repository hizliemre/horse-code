import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRoleChains } from "../../src/config/save-roles.js";

let home: string;
let path: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-cfg-"));
  path = join(home, ".horsecode", "config.json");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const write = async (obj: unknown): Promise<void> => {
  await mkdir(join(home, ".horsecode"), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
};
const read = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8"));

describe("saveRoleChains", () => {
  it("writes the chains so the next session starts with them", async () => {
    await write({ model: "x" });
    expect(await saveRoleChains(home, [{ role: "coach", models: ["a/m1", "b/m2"] }])).toBe(1);
    expect((await read()).roles).toEqual({ coach: { models: ["a/m1", "b/m2"] } });
  });

  // The single most important property: this file also holds the user's apiKey.
  it("never disturbs the apiKey or any other field", async () => {
    await write({ apiKey: "sk-secret", baseUrl: "http://x", mode: "auto", mcp: { srv: { url: "u" } } });
    await saveRoleChains(home, [{ role: "coach", models: ["a/m1"] }]);
    const c = await read();
    expect(c.apiKey).toBe("sk-secret");
    expect(c.baseUrl).toBe("http://x");
    expect(c.mode).toBe("auto");
    expect(c.mcp).toEqual({ srv: { url: "u" } });
  });

  it("keeps a role's custom prompt and skills — only the chain changes", async () => {
    await write({ roles: { coach: { models: ["old"], systemPrompt: "mine", skills: ["s1"] } } });
    await saveRoleChains(home, [{ role: "coach", models: ["new"] }]);
    expect((await read()).roles).toEqual({ coach: { models: ["new"], systemPrompt: "mine", skills: ["s1"] } });
  });

  it("leaves roles it was not asked about alone", async () => {
    await write({ roles: { coach: { models: ["a"] }, judge: { models: ["b"] } } });
    await saveRoleChains(home, [{ role: "coach", models: ["c"] }]);
    const roles = (await read()).roles as Record<string, { models: string[] }>;
    expect(roles.judge.models).toEqual(["b"]);
  });

  // Rewriting a config we could not read would silently drop whatever it held — including the key.
  it("REFUSES to write over an unparseable config", async () => {
    await mkdir(join(home, ".horsecode"), { recursive: true });
    await writeFile(path, "{ this is not json", "utf8");
    expect(await saveRoleChains(home, [{ role: "coach", models: ["a"] }])).toBe(0);
    expect(await readFile(path, "utf8")).toBe("{ this is not json"); // untouched
  });

  it("refuses a config that is not an object", async () => {
    await mkdir(join(home, ".horsecode"), { recursive: true });
    await writeFile(path, "[1,2,3]", "utf8");
    expect(await saveRoleChains(home, [{ role: "coach", models: ["a"] }])).toBe(0);
  });

  it("creates the file on a first run (there is no key to lose yet)", async () => {
    expect(await saveRoleChains(home, [{ role: "coach", models: ["a"] }])).toBe(1);
    expect((await read()).roles).toEqual({ coach: { models: ["a"] } });
  });

  it("ignores empty input rather than writing a no-op", async () => {
    await write({ apiKey: "sk-secret" });
    expect(await saveRoleChains(home, [])).toBe(0);
    expect(await saveRoleChains(home, [{ role: "coach", models: [] }])).toBe(0);
    expect((await read()).apiKey).toBe("sk-secret");
  });

  it("writes a whole 60-role assignment in one pass", async () => {
    const chains = Array.from({ length: 60 }, (_, i) => ({ role: `r${i}`, models: [`a/m${i}`, "b/f1"] }));
    expect(await saveRoleChains(home, chains)).toBe(60);
    expect(Object.keys((await read()).roles as object)).toHaveLength(60);
  });

  it("leaves no temp file behind", async () => {
    await saveRoleChains(home, [{ role: "coach", models: ["a"] }]);
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });
});
