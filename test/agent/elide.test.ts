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
