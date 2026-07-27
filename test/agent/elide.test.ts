import { describe, it, expect } from "vitest";
import { elideOldToolResults, RECENT_RESULT_BUDGET, ELIDE_MIN_CHARS } from "../../src/agent/elide.js";
import type { Message } from "../../src/core/types.js";

const toolMsg = (id: string, content: string): Message => ({ role: "tool", content, name: "read_file", toolCallId: id });
const assistant = (id: string): Message =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: "{}" }] });

/** A realistic transcript: system, user, then N (assistant tool-call → tool result) pairs of `size` each. */
const convo = (pairs: number, size: number): Message[] => {
  const out: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "do it" }];
  for (let i = 0; i < pairs; i++) out.push(assistant(`c${i}`), toolMsg(`c${i}`, "x".repeat(size)));
  return out;
};

describe("elideOldToolResults", () => {
  it("leaves a conversation that fits the budget completely alone", () => {
    const m = convo(6, 2_000); // 12k < budget
    expect(elideOldToolResults(m)).toBe(m); // same reference: nothing to do
  });

  // The point of a BUDGET over a fixed count: a coding agent holds several files open while it edits, and
  // "keep the last 2 results" threw a file's contents away after two unrelated greps.
  it("keeps many small results that a fixed count of 2 would have discarded", () => {
    const m = convo(10, 2_000); // 20k total — well under budget
    const out = elideOldToolResults(m);
    expect(out.filter((x) => x.role === "tool" && x.content.startsWith("["))).toHaveLength(0);
  });

  it("trims once the total genuinely weighs something", () => {
    const m = convo(10, 20_000); // 200k total
    const out = elideOldToolResults(m);
    const kept = out.filter((x) => x.role === "tool" && !x.content.startsWith("["));
    const keptChars = kept.reduce((n, x) => n + x.content.length, 0);
    expect(keptChars).toBeLessThanOrEqual(RECENT_RESULT_BUDGET);
    expect(out.filter((x) => x.role === "tool" && x.content.startsWith("["))).not.toHaveLength(0);
  });

  it("always keeps the NEWEST result, however large — it is what the agent is acting on", () => {
    const m = convo(4, RECENT_RESULT_BUDGET * 2);
    const tools = elideOldToolResults(m).filter((x) => x.role === "tool");
    expect(tools.at(-1)!.content.startsWith("[")).toBe(false);
    expect(tools.slice(0, -1).every((t) => t.content.startsWith("["))).toBe(true);
  });

  // The reason this is elision and not summarization: an assistant's toolCalls must stay paired with the tool
  // messages answering them, or the provider rejects the request outright.
  it("preserves every message, its role, its order and its tool-call pairing", () => {
    const m = convo(10, 20_000);
    const out = elideOldToolResults(m);
    expect(out).toHaveLength(m.length);
    expect(out.map((x) => x.role)).toEqual(m.map((x) => x.role));
    expect(out.map((x) => x.toolCallId)).toEqual(m.map((x) => x.toolCallId));
  });

  it("never touches non-tool messages", () => {
    const m = convo(10, 20_000);
    const out = elideOldToolResults(m);
    expect(out[0]).toBe(m[0]); // system
    expect(out[1]).toBe(m[1]); // user
  });

  it("leaves SMALL old results alone — the stub would not be smaller", () => {
    const m = convo(200, ELIDE_MIN_CHARS - 100);
    const out = elideOldToolResults(m);
    expect(out.every((x) => !x.content.startsWith("[earlier tool output elided"))).toBe(true);
  });

  it("says how much was dropped, and how to get it back", () => {
    const out = elideOldToolResults(convo(6, 20_000));
    const elided = out.find((x) => x.role === "tool" && x.content.startsWith("["))!;
    expect(elided.content).toMatch(/chars/);
    expect(elided.content).toMatch(/Re-run the tool/);
  });

  it("does not mutate the input — the caller keeps its full history", () => {
    const m = convo(10, 20_000);
    const snapshot = m.map((x) => x.content);
    elideOldToolResults(m);
    expect(m.map((x) => x.content)).toEqual(snapshot);
  });
});

const readOf = (id: string, path: string): Message =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path }) }] });

/**
 * Recency alone built a treadmill.
 *
 * A coder holds several files open while it works. Once a couple of large reads pushed an earlier one out of
 * the window, its stub told the agent to run the tool again — so it did, which pushed something else out,
 * which it then re-read. Measured on a real run: 496 tool calls in two and a half minutes over the same few
 * files, until the twenty-minute attempt budget killed it; 31 of one session's 243 attempts died that way.
 *
 * Keeping the newest copy of each distinct file removes the REASON to re-read, rather than arguing with it.
 */
describe("the newest look at each file survives the recency window", () => {
  const readsOf = (paths: string[], size: number): Message[] => {
    const out: Message[] = [{ role: "system", content: "sys" }];
    paths.forEach((p, i) => out.push(readOf(`c${i}`, p), toolMsg(`c${i}`, `${p} `.repeat(size / 8))));
    return out;
  };

  it("keeps a file the agent read, even when newer reads pushed it out of the budget", () => {
    // Four distinct 20k reads: the recency budget (40k) holds two, the distinct budget holds the rest.
    const out = elideOldToolResults(readsOf(["a.ts", "b.ts", "c.ts", "d.ts"], 20_000));
    const bodies = out.filter((m) => m.role === "tool").map((m) => m.content);
    expect(bodies.every((b) => !b.startsWith("["))).toBe(true);
  });

  it("elides the older copy when the SAME file is read again", () => {
    const out = elideOldToolResults(readsOf(["a.ts", "b.ts", "c.ts", "a.ts"], 20_000));
    const bodies = out.filter((m) => m.role === "tool").map((m) => m.content);
    expect(bodies[0]).toMatch(/^\[/);          // the first read of a.ts is gone…
    expect(bodies[3].startsWith("[")).toBe(false); // …because the latest one is right there
  });

  /** The stub that caused the loop must never appear where re-running is the wrong advice. */
  it("tells the agent NOT to run it again when a later call covered the same file", () => {
    const out = elideOldToolResults(readsOf(["a.ts", "b.ts", "c.ts", "a.ts"], 20_000));
    const stub = out.filter((m) => m.role === "tool").map((m) => m.content).find((b) => b.startsWith("["))!;
    expect(stub).toMatch(/Do not run it again/);
    expect(stub).not.toMatch(/Re-run the tool/);
  });

  /** An agent that opens hundreds of files must still not retain all of them. */
  it("still bounds what it keeps when the agent reads far too much", () => {
    const paths = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const out = elideOldToolResults(readsOf(paths, 20_000));
    const kept = out.filter((m) => m.role === "tool" && !m.content.startsWith("["))
      .reduce((n, m) => n + m.content.length, 0);
    expect(kept).toBeLessThan(200_000); // 60 × 20k = 1.2 MB unbounded
    expect(out.some((m) => m.role === "tool" && m.content.startsWith("["))).toBe(true);
  });
});
