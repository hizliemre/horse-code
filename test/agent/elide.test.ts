import { describe, it, expect } from "vitest";
import { elideOldToolResults, KEEP_RECENT_RESULTS, ELIDE_MIN_CHARS } from "../../src/agent/elide.js";
import type { Message } from "../../src/core/types.js";

const big = (n = ELIDE_MIN_CHARS + 500): string => "x".repeat(n);
const toolMsg = (id: string, content = big()): Message => ({ role: "tool", content, name: "read_file", toolCallId: id });
const assistant = (id: string): Message =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: "{}" }] });

/** A realistic transcript: system, user, then N (assistant tool-call → tool result) pairs. */
const convo = (pairs: number, size = big().length): Message[] => {
  const out: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "do it" }];
  for (let i = 0; i < pairs; i++) { out.push(assistant(`c${i}`), toolMsg(`c${i}`, "x".repeat(size))); }
  return out;
};

describe("elideOldToolResults", () => {
  it("leaves a short conversation completely alone", () => {
    const m = convo(KEEP_RECENT_RESULTS);
    expect(elideOldToolResults(m)).toBe(m); // same reference: nothing to do
  });

  it("elides the OLD large tool results and keeps the recent ones verbatim", () => {
    const m = convo(KEEP_RECENT_RESULTS + 3);
    const out = elideOldToolResults(m);
    const tools = out.filter((x) => x.role === "tool");
    expect(tools.slice(0, 3).every((t) => t.content.startsWith("[earlier tool output elided"))).toBe(true);
    expect(tools.slice(-KEEP_RECENT_RESULTS).every((t) => t.content === big())).toBe(true);
  });

  // The reason this is elision and not summarization: an assistant's toolCalls must stay paired with the tool
  // messages answering them, or the provider rejects the request outright.
  it("preserves every message, its role, its order and its tool-call pairing", () => {
    const m = convo(KEEP_RECENT_RESULTS + 3);
    const out = elideOldToolResults(m);
    expect(out).toHaveLength(m.length);
    expect(out.map((x) => x.role)).toEqual(m.map((x) => x.role));
    expect(out.map((x) => x.toolCallId)).toEqual(m.map((x) => x.toolCallId));
    expect(out.filter((x) => x.role === "assistant").map((x) => x.toolCalls)).toEqual(
      m.filter((x) => x.role === "assistant").map((x) => x.toolCalls));
  });

  it("never touches non-tool messages", () => {
    const m = convo(KEEP_RECENT_RESULTS + 2);
    const out = elideOldToolResults(m);
    expect(out[0]).toBe(m[0]); // system
    expect(out[1]).toBe(m[1]); // user
  });

  it("leaves SMALL old results alone — the stub would not be smaller", () => {
    const m = convo(KEEP_RECENT_RESULTS + 2, 200);
    expect(elideOldToolResults(m)).toBe(m);
  });

  it("says how much was dropped, and how to get it back", () => {
    const out = elideOldToolResults(convo(KEEP_RECENT_RESULTS + 1));
    const elided = out.find((x) => x.role === "tool" && x.content.startsWith("["))!;
    expect(elided.content).toMatch(/chars/);
    expect(elided.content).toMatch(/Re-run the tool/);
  });

  it("actually shrinks the payload", () => {
    const m = convo(KEEP_RECENT_RESULTS + 10);
    const before = m.reduce((n, x) => n + x.content.length, 0);
    const after = elideOldToolResults(m).reduce((n, x) => n + x.content.length, 0);
    expect(after).toBeLessThan(before / 2);
  });

  it("does not mutate the input — the caller keeps its full history", () => {
    const m = convo(KEEP_RECENT_RESULTS + 2);
    const snapshot = m.map((x) => x.content);
    elideOldToolResults(m);
    expect(m.map((x) => x.content)).toEqual(snapshot);
  });
});
