import { describe, it, expect, vi } from "vitest";
import { compactHistory, historyTokens } from "../../src/engine/compaction.js";
import type { Message } from "../../src/core/types.js";

const msg = (role: Message["role"], content: string): Message => ({ role, content });
const convo = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} `.repeat(20)));

describe("historyTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(historyTokens([msg("user", "x".repeat(400))])).toBe(100);
  });
});

describe("compactHistory", () => {
  it("returns the history unchanged (no LLM call) when under budget", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const h = convo(4);
    expect(await compactHistory(h, { maxTokens: 1_000_000, keepRecent: 2, summarize })).toBe(h);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("returns the history unchanged when it's shorter than keepRecent+1", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const h = convo(2);
    expect(await compactHistory(h, { maxTokens: 1, keepRecent: 8, summarize })).toBe(h);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("over budget: summarizes the ancient region and keeps the recent tail verbatim", async () => {
    const summarize = vi.fn(async (c: string) => `SUM(${c.length})`);
    const h = convo(6); // 6 messages
    const out = await compactHistory(h, { maxTokens: 10, keepRecent: 2, summarize });
    expect(summarize).toHaveBeenCalledOnce();
    expect(out).toHaveLength(3); // 1 summary + 2 recent
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("Summary of the earlier conversation");
    expect(out.slice(1)).toEqual(h.slice(-2)); // recent tail is verbatim
  });
});
