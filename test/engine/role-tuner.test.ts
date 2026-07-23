import { describe, it, expect } from "vitest";
import { tuneRoleModels } from "../../src/engine/role-tuner.js";
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
