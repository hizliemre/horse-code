import { describe, it, expect } from "vitest";
import { elideInPlace, elideOldToolResults, RECENT_RESULT_BUDGET } from "../../src/agent/elide.js";
import type { Message } from "../../src/core/types.js";

const RESULT = "x".repeat(30_000); // the read_file cap — a realistic tool result

const history = (calls: number): Message[] => {
  const w: Message[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < calls; i++) {
    w.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read_file", arguments: "{}" }] } as Message);
    w.push({ role: "tool", toolCallId: `t${i}`, name: "read_file", content: RESULT } as Message);
  }
  return w;
};

const size = (w: Message[]): number => w.reduce((n, m) => n + m.content.length, 0);

/**
 * A five-hour run with nine agents died on the V8 heap limit.
 *
 * Elision only ever touched the COPY handed to the provider; the agent's own history kept every result at
 * full size for the life of the run. At 800 calls and 30 KB a result that is 24 MB an agent, and it is
 * re-allocated on every turn — which is why the crash reads "Ineffective mark-compacts" rather than a clean
 * out-of-memory.
 */
describe("elideInPlace frees what the history will never read again", () => {
  it("releases the bulk of a long run's history", () => {
    const w = history(800);
    const before = size(w);
    const freed = elideInPlace(w);
    expect(before).toBeGreaterThan(20e6); // ~24 MB retained per agent
    // What remains is the live budget plus one short stub per elided result — a fraction of a percent of
    // what was held. Asserted as a ratio: the stubs scale with the call count, so an absolute ceiling would
    // just encode today's run length.
    expect(size(w) / before).toBeLessThan(0.01);
    expect(freed).toBeGreaterThan(before * 0.98);
  });

  it("keeps the newest results intact — they are still being reasoned about", () => {
    const w = history(10);
    elideInPlace(w);
    const results = w.filter((m) => m.role === "tool");
    expect(results[results.length - 1].content).toBe(RESULT);
  });

  it("leaves a short history untouched and reports nothing freed", () => {
    const w = history(1);
    expect(elideInPlace(w)).toBe(0);
    expect(w.filter((m) => m.role === "tool")[0].content).toBe(RESULT);
  });

  /** Elision is one-way: messages are only appended, so a result outside the budget only gets older. */
  it("is stable — running it again frees nothing more", () => {
    const w = history(100);
    elideInPlace(w);
    const after = size(w);
    expect(elideInPlace(w)).toBe(0);
    expect(size(w)).toBe(after);
  });

  it("preserves the message count and their pairing", () => {
    const w = history(50);
    const before = w.length;
    const ids = w.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    elideInPlace(w);
    expect(w.length).toBe(before);
    expect(w.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(ids);
  });

  it("agrees with the pure version about what to elide", () => {
    const a = history(60);
    const b = history(60);
    elideInPlace(a);
    expect(a.map((m) => m.content)).toEqual(elideOldToolResults(b).map((m) => m.content));
  });

  it("an empty history is not an error", () => {
    const w: Message[] = [];
    expect(elideInPlace(w)).toBe(0);
  });
});
