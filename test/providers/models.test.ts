import { describe, it, expect } from "vitest";
import { listOmniRouteModels, isFreeModel } from "../../src/providers/models.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

function fakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: ok ? status : status });
}

describe("listOmniRouteModels", () => {
  it("returns sorted, de-duplicated ids from data[]", async () => {
    const fetch = fakeFetch({ data: [{ id: "b/two" }, { id: "a/one" }, { id: "a/one" }] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch });
    expect(ids).toEqual(["a/one", "b/two"]);
  });

  it("sends Authorization header when apiKey is given, hits /api/v1/models", async () => {
    let seenUrl = ""; let seenAuth: string | null = null;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await listOmniRouteModels({ baseUrl: "http://x/", apiKey: "k", fetch });
    expect(seenUrl).toBe("http://x/api/v1/models");
    expect(seenAuth).toBe("Bearer k");
  });

  it("throws on a non-ok response", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 500 });
    await expect(listOmniRouteModels({ baseUrl: "http://x", fetch })).rejects.toThrow();
  });

  it("filters out free/unofficial models (never shown → never picked/assigned)", async () => {
    const fetch = fakeFetch({ data: [
      { id: "cc/claude-opus-4-8", name: "Claude Opus 4.8" },     // paid → kept
      { id: "tllm/GPT_5_4", name: "GPT-5.4 (The Old LLM 🆓)" },  // 🆓 in name → dropped
      { id: "oc/deepseek-v4-flash-free", name: "DeepSeek Flash" }, // -free id → dropped
      { id: "veo-free/veo", name: "Veo" },                        // free provider → dropped
      { id: "aug/claude-sonnet-4.6", name: "Claude Sonnet 4.6" }, // paid → kept
    ] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch });
    expect(ids).toEqual(["aug/claude-sonnet-4.6", "cc/claude-opus-4-8"]);
  });

  it("with `sources`, keeps only models whose owned_by is an allowed subscription (drops combos/unofficial)", async () => {
    const fetch = fakeFetch({ data: [
      { id: "cc/claude-opus-4-8", name: "Opus", owned_by: "claude" },
      { id: "cx/gpt-5.6-sol", name: "Codex", owned_by: "codex" },
      { id: "aug/claude-sonnet-4.6", name: "Sonnet", owned_by: "auggie" }, // not a connected source
      { id: "auto/best-coding", name: "Best Coding", owned_by: "combo" }, // omniroute combo
      { id: "antigravity/gemini-3.5-pro", name: "Gemini", owned_by: "antigravity" },
    ] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch, sources: ["antigravity", "claude", "codex", "opencode-go"] });
    expect(ids).toEqual(["antigravity/gemini-3.5-pro", "cc/claude-opus-4-8", "cx/gpt-5.6-sol"]);
    expect(ids).not.toContain("aug/claude-sonnet-4.6"); // auggie excluded
    expect(ids).not.toContain("auto/best-coding"); // combo excluded
  });

  it("collapses alias models (parent → canonical), keeping the canonical and real variants", async () => {
    const fetch = fakeFetch({ data: [
      { id: "cc/claude-opus-4-8", owned_by: "claude", parent: null },            // canonical → kept
      { id: "claude/claude-opus-4-8", owned_by: "claude", parent: "cc/claude-opus-4-8" }, // alias → dropped
      { id: "cx/gpt-5.6-sol", owned_by: "codex", parent: null },                 // canonical → kept
      { id: "codex/gpt-5.6-sol", owned_by: "codex", parent: "cx/gpt-5.6-sol" },  // alias → dropped
      { id: "no-think/cc/claude-opus-4-8", owned_by: "claude", parent: null },   // real variant → kept
    ] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch });
    expect(ids).toEqual(["cc/claude-opus-4-8", "cx/gpt-5.6-sol", "no-think/cc/claude-opus-4-8"]);
    expect(ids).not.toContain("claude/claude-opus-4-8"); // alias hidden
    expect(ids).not.toContain("codex/gpt-5.6-sol"); // alias hidden
  });

  it("keeps an alias when its canonical parent is absent (never drops to nothing)", async () => {
    const fetch = fakeFetch({ data: [
      { id: "claude/claude-opus-4-8", owned_by: "claude", parent: "cc/claude-opus-4-8" }, // parent not in list → kept
    ] });
    expect(await listOmniRouteModels({ baseUrl: "http://x", fetch })).toEqual(["claude/claude-opus-4-8"]);
  });

  it("empty `sources` = no source filter (all non-free kept)", async () => {
    const fetch = fakeFetch({ data: [{ id: "aug/x", owned_by: "auggie" }, { id: "cc/y", owned_by: "claude" }] });
    expect(await listOmniRouteModels({ baseUrl: "http://x", fetch, sources: [] })).toEqual(["aug/x", "cc/y"]);
  });
});

describe("isFreeModel", () => {
  it("flags 🆓 / 'free' in the name, -free ids, free-tier + known-anonymous providers", () => {
    expect(isFreeModel("tllm/GPT_5_4", "GPT-5.4 (The Old LLM 🆓)")).toBe(true);
    expect(isFreeModel("oc/deepseek-v4-flash-free")).toBe(true);
    expect(isFreeModel("veo-free/veo")).toBe(true);
    expect(isFreeModel("x/y", "Some Free Model")).toBe(true);
    expect(isFreeModel("ddgw/gpt-4o-mini", "GPT-4o Mini")).toBe(true); // DuckDuckGo anonymous scrape
  });
  it("keeps paid/official models", () => {
    expect(isFreeModel("cc/claude-opus-4-8", "Claude Opus 4.8")).toBe(false);
    expect(isFreeModel("codex/gpt-5.6-sol", "GPT-5.6 Sol")).toBe(false);
    expect(isFreeModel("aug/claude-sonnet-4.6")).toBe(false);
  });
});
