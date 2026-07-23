import { describe, it, expect } from "vitest";
import { tuneRoleModels } from "../../src/engine/role-tuner.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

const MODELS = [
  "cc/claude-fable-5", "cc/claude-opus-4-8", "cc/claude-sonnet-5",
  "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro", "oc/deepseek-v4-flash",
];

function submit(obj: unknown): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: JSON.stringify(obj) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("tuneRoleModels", () => {
  it("applies the LLM's valid picks and returns its reasoning", async () => {
    const p = new MockProvider([submit({
      reasoning: "Coach is high-volume so it gets sonnet, judge gets the flagship fable.",
      assignments: [
        { role: "coach", models: ["cc/claude-sonnet-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"] },
        { role: "judge", models: ["cc/claude-fable-5", "cc/claude-opus-4-8", "cx/gpt-5.6-sol-ultra"] },
      ],
    })]);
    const { reasoning, chains, tuner } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coach", "judge"] });
    expect(reasoning).toMatch(/high-volume/);
    expect(tuner).toBe("cc/claude-fable-5"); // strongest discovered model does the reasoning
    const map = Object.fromEntries(chains.map((c) => [c.role, c.models]));
    expect(map.coach).toEqual(["cc/claude-sonnet-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"]);
    expect(map.judge[0]).toBe("cc/claude-fable-5");
  });

  it("drops invented/duplicate model ids and pads the chain to 3 from the heuristic", async () => {
    const p = new MockProvider([submit({
      reasoning: "ok",
      assignments: [
        { role: "coder", models: ["cc/claude-sonnet-5", "does/not-exist", "cc/claude-sonnet-5"] }, // 1 valid, 1 invalid, 1 dup
      ],
    })]);
    const { chains } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coder"] });
    const coder = chains[0];
    expect(coder.role).toBe("coder");
    expect(coder.models.length).toBe(3); // padded back to 3
    expect(coder.models[0]).toBe("cc/claude-sonnet-5"); // the one valid pick is kept, first
    expect(new Set(coder.models).size).toBe(3); // distinct
    expect(coder.models).not.toContain("does/not-exist"); // invented id dropped
  });

  it("falls back to the heuristic for any role the LLM omitted", async () => {
    const p = new MockProvider([submit({ reasoning: "only did judge", assignments: [
      { role: "judge", models: ["cc/claude-fable-5", "cx/gpt-5.6-sol-ultra", "antigravity/gemini-3-pro"] },
    ] })]);
    const { chains } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["judge", "refiner"] });
    const refiner = chains.find((c) => c.role === "refiner")!;
    expect(refiner.models.length).toBe(3); // filled from the heuristic even though the LLM skipped it
  });

  it("on LLM failure, returns the heuristic assignment for every role", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]); // structured role throws
    const { chains, reasoning } = await tuneRoleModels({ provider: p, models: MODELS, roles: ["coach", "judge", "coder"] });
    expect(reasoning).toMatch(/failed|heuristic/i);
    expect(chains).toHaveLength(3);
    for (const c of chains) expect(c.models.length).toBeGreaterThanOrEqual(1);
  });

  it("empty model list → heuristic (empty) chains, no crash", async () => {
    const p = new MockProvider([]);
    const { chains } = await tuneRoleModels({ provider: p, models: [], roles: ["coach"] });
    expect(chains).toEqual([]);
  });
});
