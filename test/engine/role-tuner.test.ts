import { describe, it, expect } from "vitest";
import { tuneRoleModels, spreadLoad, MAX_MODEL_SHARE } from "../../src/engine/role-tuner.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

const MODELS = [
  "cc/claude-fable-5", "cc/claude-opus-4-8", "cc/claude-sonnet-5",
  "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro", "oc/deepseek-v4-flash",
];

/** One streamed reply: reasoning prose, then a fenced JSON assignments block. */
function reply(reasoning: string, assignments: unknown): ChatEvent[] {
  const json = "```json\n" + JSON.stringify({ assignments }) + "\n```";
  return [
    { type: "text-delta", text: reasoning },
    { type: "text-delta", text: "\n" + json },
    { type: "done", finishReason: "stop" },
  ];
}

describe("tuneRoleModels", () => {
  it("streams the reasoning (JSON block excluded) and applies the LLM's valid picks", async () => {
    const p = new MockProvider([reply("Coach is high-volume so it gets sonnet; judge gets flagship fable.", [
      { role: "coach", models: ["cc/claude-sonnet-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"] },
      { role: "judge", models: ["cc/claude-fable-5", "cc/claude-opus-4-8", "cx/gpt-5.6-sol-ultra"] },
    ])]);
    const streamed: string[] = [];
    const { reasoning, chains, tuner } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coach", "judge"], onReason: (d) => streamed.push(d) });
    expect(tuner).toBe("cc/claude-fable-5"); // strongest discovered model does the reasoning
    expect(reasoning).toMatch(/high-volume/);
    expect(streamed.join("")).toContain("high-volume"); // reasoning streamed live
    expect(streamed.join("")).not.toContain("```"); // the JSON fence is hidden from the stream
    const map = Object.fromEntries(chains.map((c) => [c.role, c.models]));
    expect(map.coach).toEqual(["cc/claude-sonnet-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"]);
    expect(map.judge[0]).toBe("cc/claude-fable-5");
  });

  it("drops invented/duplicate model ids and pads the chain to 3 from the heuristic", async () => {
    const p = new MockProvider([reply("ok", [
      { role: "coder", models: ["cc/claude-sonnet-5", "does/not-exist", "cc/claude-sonnet-5"] },
    ])]);
    const { chains } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coder"] });
    const coder = chains[0];
    expect(coder.models.length).toBe(3);
    expect(coder.models[0]).toBe("cc/claude-sonnet-5");
    expect(new Set(coder.models).size).toBe(3);
    expect(coder.models).not.toContain("does/not-exist");
  });

  it("falls back to the heuristic for any role the LLM omitted", async () => {
    const p = new MockProvider([reply("only did judge", [
      { role: "judge", models: ["cc/claude-fable-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"] },
    ])]);
    const { chains } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["judge", "refiner"] });
    const refiner = chains.find((c) => c.role === "refiner")!;
    expect(refiner.models.length).toBe(3);
  });

  it("on stream error, returns the heuristic assignment for every role", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    const { chains, reasoning } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coach", "judge", "coder"] });
    expect(reasoning).toMatch(/failed|heuristic/i);
    expect(chains).toHaveLength(3);
    for (const c of chains) expect(c.models.length).toBeGreaterThanOrEqual(1);
  });

  it("unparseable reply → heuristic chains (no crash)", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "I couldn't decide." }, { type: "done", finishReason: "stop" }]]);
    const { chains } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coach"] });
    expect(chains).toHaveLength(1);
    expect(chains[0].models.length).toBeGreaterThanOrEqual(1);
  });

  it("empty model list → heuristic (empty) chains, no crash", async () => {
    const p = new MockProvider([]);
    const { chains } = await tuneRoleModels({ provider: p, models: [], roles: ["coach"] });
    expect(chains).toEqual([]);
  });
});

// Observed in the wild: the tuner satisfied "fallbacks on a different source" in EVERY chain and still made
// one model the last link of ~40 of 60 roles. Each chain looked diverse; the fleet did not — and the moment
// the other sources rate-limit, all 40 land on one subscription at once.
describe("fleet-wide concentration cap", () => {
  const CATALOG = [
    "cc/claude-opus-4-8", "cc/claude-opus-4-7", "cc/claude-sonnet-5",
    "cx/gpt-5.6-sol-ultra", "cx/gpt-5.6-terra-high", "cx/gpt-5.5-high",
    "antigravity/claude-opus-4-6-thinking", "antigravity/gemini-3.1-pro-high", "antigravity/claude-sonnet-5",
    "oc/deepseek-v4-pro", "oc/glm-5.2",
  ];
  const HOG = "antigravity/claude-opus-4-6-thinking";
  const roles = Array.from({ length: 60 }, (_, i) => `role-${i}`);
  /** Every chain distinct per-chain, yet all ending on the same model — exactly the observed shape. */
  const piled = roles.map((role, i) => ({
    role,
    models: [CATALOG[i % 3], CATALOG[3 + (i % 3)], HOG],
  }));
  const share = (chains: { models: string[] }[], m: string): number =>
    chains.filter((c) => c.models.includes(m)).length / chains.length;

  it("cuts an over-represented model down to what the catalog can actually support", () => {
    expect(share(piled, HOG)).toBeGreaterThan(0.9); // before: on nearly every chain
    const out = spreadLoad(piled, CATALOG);
    // 11 models over 180 slots means SOME model must carry ~17 of them; the cap is the pigeonhole minimum
    // here, not the 25% share. Either way the pile-up is gone.
    const floor = Math.ceil((60 * 3) / CATALOG.length) / 60;
    expect(share(out, HOG)).toBeLessThanOrEqual(floor + 0.01);
    expect(share(out, HOG)).toBeLessThan(share(piled, HOG) / 3);
  });

  it("honours the 25% share once the catalog is wide enough for it to bind", () => {
    // Real families — an unrecognised vanity id is deliberately not assignable, so it cannot absorb load.
    const wide = [...CATALOG, ...Array.from({ length: 25 }, (_, i) => `src${i}/qwen3-${i}-plus`)];
    const out = spreadLoad(piled, wide);
    expect(share(out, HOG)).toBeLessThanOrEqual(MAX_MODEL_SHARE + 0.01);
  });

  it("never touches a PRIMARY — that is the tuner's actual reasoning about the role", () => {
    const out = spreadLoad(piled, CATALOG);
    for (let i = 0; i < piled.length; i++) expect(out[i].models[0]).toBe(piled[i].models[0]);
  });

  it("keeps every chain the same length and free of duplicates", () => {
    for (const c of spreadLoad(piled, CATALOG)) {
      expect(c.models).toHaveLength(3);
      expect(new Set(c.models).size).toBe(3);
    }
  });

  it("only offers real assignable models as replacements — never an image endpoint", () => {
    const withJunk = [...CATALOG, "antigravity/gemini-3-pro-image-preview", "x/veo-3-video"];
    const used = new Set(spreadLoad(piled, withJunk).flatMap((c) => c.models));
    expect([...used].some((m) => /image|veo/.test(m))).toBe(false);
  });

  // With few models SOME model must repeat; asking for less than the unavoidable average would churn forever.
  it("never demands less than the pigeonhole minimum", () => {
    const tiny = ["a/m1", "b/m2"];
    const chains = Array.from({ length: 10 }, (_, i) => ({ role: `r${i}`, models: ["a/m1", "b/m2"] }));
    const out = spreadLoad(chains, tiny);
    for (const c of out) expect(c.models).toHaveLength(2); // nobody is stranded
  });

  it("leaves a small fleet alone — a repeated fallback across 3 roles is not a concentration problem", () => {
    const few = Array.from({ length: 3 }, (_, i) => ({ role: `r${i}`, models: ["cc/claude-opus-4-8", HOG] }));
    expect(spreadLoad(few, CATALOG)).toEqual(few);
  });
});
