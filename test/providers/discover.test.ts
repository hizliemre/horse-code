import { describe, it, expect } from "vitest";
import { discoverSources, type CatalogModel } from "../../src/providers/discover.js";

const catalog: CatalogModel[] = [
  { id: "cc/claude-haiku-4-5", owned_by: "claude", name: "Haiku" },
  { id: "cc/claude-opus-4-8", owned_by: "claude", name: "Opus" },
  { id: "cx/gpt-5.6-sol", owned_by: "codex", name: "Codex" },
  { id: "antigravity/gemini-3.5-flash", owned_by: "antigravity", name: "Gemini Flash" },
  { id: "aug/claude-sonnet-4.6", owned_by: "auggie", name: "Sonnet" }, // not connected
  { id: "auto/best-coding", owned_by: "combo", name: "Best" }, // omniroute meta → skipped
  { id: "ddgw/gpt-4o-mini", owned_by: "duckduckgo-web", name: "GPT-4o Mini" }, // free scrape → skipped
  { id: "tllm/x", owned_by: "theoldllm", name: "X (🆓)" }, // free → skipped
];

describe("discoverSources", () => {
  it("returns only the sources whose probe succeeds; skips free + combo sources", async () => {
    // connected = claude, codex, antigravity; auggie fails the probe
    const connected = new Set(["claude", "codex", "antigravity"]);
    const probed: string[] = [];
    const probe = async (model: string): Promise<boolean> => {
      probed.push(model);
      const source = model.startsWith("cc/") ? "claude" : model.startsWith("cx/") ? "codex" : model.startsWith("antigravity/") ? "antigravity" : "auggie";
      return connected.has(source);
    };
    const found = await discoverSources({ catalog, probe });
    expect(found).toEqual(["antigravity", "claude", "codex"]); // sorted, auggie excluded
    // free (ddgw, tllm) and combo were never probed
    expect(probed.some((m) => m.startsWith("ddgw/") || m.startsWith("tllm/") || m.startsWith("auto/"))).toBe(false);
    // claude was probed via the cheap haiku model, not opus
    expect(probed).toContain("cc/claude-haiku-4-5");
    expect(probed).not.toContain("cc/claude-opus-4-8");
  });

  it("empty when nothing probes successfully", async () => {
    expect(await discoverSources({ catalog, probe: async () => false })).toEqual([]);
  });
});
