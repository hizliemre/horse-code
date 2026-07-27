import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMaxParallel, MIN_PARALLEL, MAX_PARALLEL } from "../../src/config/save-parallel.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-par-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(home, ".horsecode", "config.json"), "utf8")) as Record<string, unknown>;

/**
 * How many tasks may run at once belongs to the machine and its subscriptions, not to one session — having
 * to rediscover it on every start is the defect `/roles adjust` had before it wrote anything down.
 */
describe("saveMaxParallel", () => {
  it("writes the value to the global config", async () => {
    expect(await saveMaxParallel(home, 12)).toBe(true);
    expect((await read()).maxParallel).toBe(12);
  });

  /** The API key lives in this file. A setting that rewrites it must preserve everything it did not touch. */
  it("leaves the rest of the config alone", async () => {
    await mkdir(join(home, ".horsecode"), { recursive: true });
    await writeFile(join(home, ".horsecode", "config.json"),
      JSON.stringify({ apiKey: "sk-secret", model: "cc/opus", roles: { coder: { models: ["m"] } } }));
    await saveMaxParallel(home, 6);
    const c = await read();
    expect(c.apiKey).toBe("sk-secret");
    expect(c.model).toBe("cc/opus");
    expect(c.maxParallel).toBe(6);
  });

  // The loader's schema rejects anything outside these, so writing one would break the next start.
  it("refuses a value the config loader would not accept", async () => {
    expect(await saveMaxParallel(home, 0)).toBe(false);
    expect(await saveMaxParallel(home, MAX_PARALLEL + 1)).toBe(false);
    expect(await saveMaxParallel(home, 2.5)).toBe(false);
    expect(await saveMaxParallel(home, Number.NaN)).toBe(false);
  });

  it("accepts both ends of the range", async () => {
    expect(await saveMaxParallel(home, MIN_PARALLEL)).toBe(true);
    expect(await saveMaxParallel(home, MAX_PARALLEL)).toBe(true);
  });
});
