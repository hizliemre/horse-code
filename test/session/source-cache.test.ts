import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourceCache, saveSourceCache } from "../../src/session/source-cache.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-src-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("source-cache", () => {
  it("saves + loads discovered sources, keyed per baseUrl", () => {
    expect(loadSourceCache(home, "http://a")).toBeUndefined();
    saveSourceCache(home, "http://a", ["claude", "codex"]);
    saveSourceCache(home, "http://b", ["antigravity"]);
    expect(loadSourceCache(home, "http://a")).toEqual(["claude", "codex"]);
    expect(loadSourceCache(home, "http://b")).toEqual(["antigravity"]); // isolated per baseUrl
  });

  it("overwrites the same baseUrl's entry on re-save", () => {
    saveSourceCache(home, "http://a", ["claude"]);
    saveSourceCache(home, "http://a", ["claude", "codex", "antigravity"]);
    expect(loadSourceCache(home, "http://a")).toEqual(["claude", "codex", "antigravity"]);
  });
});
