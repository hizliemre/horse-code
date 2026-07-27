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

/**
 * A `write_file` call carries the entire file in its ARGUMENTS, on an assistant message — which elision
 * never touched. The body was retained for the life of the run and re-sent on every subsequent turn.
 *
 * Measured on a coder writing forty 12 KB files: after eliding every result, 92% of what remained was
 * arguments, and each turn re-sent all of it. That is both the heap and the token bill.
 */
describe("a past call's arguments are elided with its result", () => {
  const FILE = "y".repeat(12_000);
  const withWrites = (n: number): Message[] => {
    const w: Message[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < n; i++) {
      w.push({ role: "assistant", content: "", toolCalls: [
        { id: `t${i}`, name: "write_file", arguments: JSON.stringify({ path: `src/f${i}.ts`, content: FILE }) },
      ] } as Message);
      w.push({ role: "tool", toolCallId: `t${i}`, name: "write_file", content: "written" } as Message);
    }
    return w;
  };
  const argSize = (w: Message[]): number =>
    w.reduce((n, m) => n + (m.toolCalls?.reduce((a, c) => a + c.arguments.length, 0) ?? 0), 0);

  it("releases the file bodies the results left behind", () => {
    const w = withWrites(40);
    const before = argSize(w);
    elideInPlace(w);
    expect(before).toBeGreaterThan(400_000); // ~480 KB of file bodies, re-sent every turn
    // What survives is the budget, not a fraction: the newest exchanges keep their arguments whole, and
    // 40 KB of budget is about three 12 KB files. Asserting a percentage would just encode this fixture.
    expect(argSize(w)).toBeLessThanOrEqual(RECENT_RESULT_BUDGET + 12_000);
  });

  /** `path` is what makes the history readable — it says which file. The body says nothing more. */
  it("keeps the short fields that identify the call", () => {
    const w = withWrites(40);
    elideInPlace(w);
    const first = JSON.parse(w.find((m) => m.toolCalls)!.toolCalls![0].arguments) as Record<string, string>;
    expect(first.path).toBe("src/f0.ts");
    expect(first.content).toMatch(/elided/);
  });

  /** Paired: the history never shows a stubbed result beside the full request that produced it. */
  it("leaves the newest call whole, as its result is", () => {
    const w = withWrites(40);
    elideInPlace(w);
    const last = [...w].reverse().find((m) => m.toolCalls)!.toolCalls![0];
    expect(JSON.parse(last.arguments).content).toBe(FILE);
  });

  it("does not touch a call whose result was never elided", () => {
    const w = withWrites(1);
    elideInPlace(w);
    expect(JSON.parse(w[1].toolCalls![0].arguments).content).toBe(FILE);
  });

  it("leaves small arguments alone", () => {
    const w: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "grep", arguments: '{"pattern":"x"}' }] } as Message,
      { role: "tool", toolCallId: "a", name: "grep", content: "y".repeat(50_000) } as Message,
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "grep", arguments: '{"pattern":"z"}' }] } as Message,
      { role: "tool", toolCallId: "b", name: "grep", content: "y".repeat(50_000) } as Message,
    ];
    elideInPlace(w);
    expect(w[0].toolCalls![0].arguments).toBe('{"pattern":"x"}');
  });

  /** "Re-run the tool" is wrong advice for a write: re-running means writing the file a second time. */
  it("tells the agent the value was already applied, not to send it again", () => {
    const w = withWrites(40);
    elideInPlace(w);
    const first = w.find((m) => m.toolCalls)!.toolCalls![0].arguments;
    expect(first).toMatch(/already applied/);
    expect(first).not.toMatch(/Re-run the tool/);
  });

  it("survives arguments that are not JSON", () => {
    const w: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", arguments: "z".repeat(20_000) }] } as Message,
      { role: "tool", toolCallId: "a", name: "x", content: "y".repeat(50_000) } as Message,
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "x", arguments: "{}" }] } as Message,
      { role: "tool", toolCallId: "b", name: "x", content: "y".repeat(50_000) } as Message,
    ];
    expect(() => elideInPlace(w)).not.toThrow();
    expect(w[0].toolCalls![0].arguments.length).toBeLessThan(200);
  });
});
