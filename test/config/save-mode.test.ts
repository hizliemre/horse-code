import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMode } from "../../src/config/save-mode.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-mode-"));
  await mkdir(join(home, ".horsecode"), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(home, ".horsecode", "config.json"), "utf8")) as Record<string, unknown>;

/**
 * The permission mode was the one deliberate choice that did not survive the session.
 *
 * `config.mode` has always existed and has always been read at startup — `/mode` simply never wrote it, so
 * every session began at the default and the setting had to be made again. Reported plainly: "mode komutu
 * kalıcı olmuyor, her seferinde tekrar ayarlamak zorunda kalıyorum".
 */
describe("the permission mode survives the session that chose it", () => {
  it("writes the chosen mode", async () => {
    await writeFile(join(home, ".horsecode", "config.json"), JSON.stringify({ apiKey: "sk-secret" }), "utf8");
    expect(await saveMode(home, "auto")).toBe(true);
    const cfg = await read();
    expect(cfg.mode).toBe("auto");
    expect(cfg.apiKey).toBe("sk-secret");   // …and everything else is carried through untouched
  });

  it("replaces a previous choice rather than accumulating", async () => {
    await writeFile(join(home, ".horsecode", "config.json"), JSON.stringify({ mode: "ask" }), "utf8");
    await saveMode(home, "acceptEdits");
    expect((await read()).mode).toBe("acceptEdits");
  });

  it("creates the config when there is none — a first run has no key to lose", async () => {
    expect(await saveMode(home, "ask")).toBe(true);
    expect((await read()).mode).toBe("ask");
  });

  /** A config we cannot parse is one we must not rewrite: overwriting it would destroy whatever it held. */
  it("refuses to overwrite a config it could not read", async () => {
    await writeFile(join(home, ".horsecode", "config.json"), "{ not json", "utf8");
    expect(await saveMode(home, "auto")).toBe(false);
    expect(await readFile(join(home, ".horsecode", "config.json"), "utf8")).toBe("{ not json");
  });
});
