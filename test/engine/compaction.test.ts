import { describe, it, expect, vi } from "vitest";
import { compactHistory, historyTokens, type CompactionCache } from "../../src/engine/compaction.js";
import type { Message } from "../../src/core/types.js";

const msg = (role: Message["role"], content: string): Message => ({ role, content });
// each message ~500 chars ≈ 125 tokens
const convo = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} `.repeat(60)));

const opts = (over: Partial<Parameters<typeof compactHistory>[1]> = {}): Parameters<typeof compactHistory>[1] => ({
  maxTokens: 10,
  keepRecent: 2,
  reSummarizeTokens: 100_000, // effectively never re-fold, unless overridden
  summarize: vi.fn(async (c: string) => `SUM(${c.length})`),
  ...over,
});

describe("historyTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(historyTokens([msg("user", "x".repeat(400))])).toBe(100);
  });
});

describe("compactHistory", () => {
  it("returns the history unchanged (no LLM call) when under budget", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const h = convo(4);
    const out = await compactHistory(h, opts({ maxTokens: 1_000_000, summarize }));
    expect(out.messages).toBe(h);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("over budget (no cache): summarizes the ancient region, keeps the recent tail, returns a cache", async () => {
    const summarize = vi.fn(async (c: string) => `SUM(${c.length})`);
    const h = convo(6);
    const out = await compactHistory(h, opts({ summarize }));
    expect(summarize).toHaveBeenCalledOnce();
    expect(out.messages).toHaveLength(3); // 1 summary + 2 recent
    expect(out.messages[0].content).toContain("Summary of the earlier conversation");
    expect(out.messages.slice(1)).toEqual(h.slice(-2));
    expect(out.cache?.coveredCount).toBe(4); // 6 - keepRecent(2)
  });

  it("reuses the cached summary and keeps a small delta verbatim — NO second summarizer call", async () => {
    const summarize = vi.fn(async (c: string) => `SUM(${c.length})`);
    const first = await compactHistory(convo(6), opts({ summarize }));
    expect(summarize).toHaveBeenCalledTimes(1);

    // two more turns appended; the delta (2 messages) is below reSummarizeTokens → reuse
    const h2 = convo(8);
    const second = await compactHistory(h2, opts({ summarize }), first.cache);
    expect(summarize).toHaveBeenCalledTimes(1); // still one call total — cache reused
    // output = cached summary + verbatim delta (2) + recent tail (2)
    expect(second.messages[0].content).toContain("Summary of the earlier conversation");
    expect(second.messages.slice(-2)).toEqual(h2.slice(-2));
    expect(second.cache?.coveredCount).toBe(4); // unchanged
  });

  it("re-folds the delta into the summary once it grows past reSummarizeTokens (one more call)", async () => {
    const summarize = vi.fn(async (c: string) => `SUM(${c.length})`);
    const first = await compactHistory(convo(6), opts({ summarize }));
    // low threshold → the 2-message delta now exceeds it → re-summarize
    const h2 = convo(8);
    const second = await compactHistory(h2, opts({ summarize, reSummarizeTokens: 1 }), first.cache);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(second.cache?.coveredCount).toBe(6); // 8 - keepRecent(2)
    // the summarizer got the prior summary folded in
    expect(summarize.mock.calls[1][0]).toContain("Existing summary:");
  });

  it("invalidates a stale cache when the transcript prefix changed (e.g. /clear, /resume)", async () => {
    const summarize = vi.fn(async (c: string) => `SUM(${c.length})`);
    const stale: CompactionCache = { coveredCount: 4, coveredChars: 999999, summary: "OLD" }; // wrong fingerprint
    const out = await compactHistory(convo(6), opts({ summarize }), stale);
    expect(summarize).toHaveBeenCalledOnce(); // re-summarized from scratch, didn't trust the stale cache
    expect(out.messages[0].content).not.toContain("OLD");
  });
});
