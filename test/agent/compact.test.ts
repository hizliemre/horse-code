import { describe, it, expect } from "vitest";
import { compact, stub, MAX_CONVERSATION_CHARS, KEEP_RECENT_RESULTS } from "../../src/agent/compact.js";
import type { Message } from "../../src/core/types.js";

const tool = (name: string, chars: number): Message =>
  ({ role: "tool", name, tool_call_id: `c${chars}`, content: "x".repeat(chars) }) as Message;
const said = (text: string): Message => ({ role: "assistant", content: text });

/**
 * Nothing dropped anything: `working` only ever grew.
 *
 * Measured before one verification run was stopped: 1,033,926 characters of tool output in a single
 * conversation — 654,354 of it re-reads of one document — re-sent on every later call. The conversation
 * reached 168 messages and 200,193 characters per request, still climbing, at 23 requests and 1.5M tokens.
 */
describe("a conversation that stopped being workable", () => {
  const big = (): Message[] => [
    { role: "system", content: "P" },
    { role: "user", content: "do it" },
    ...Array.from({ length: 40 }, (_, i) => tool("read_file", 10_000 + i)),
    said("here is what I found"),
  ];

  it("puts away the oldest tool results until it fits", () => {
    const { messages, freed } = compact(big(), 200_000);
    expect(freed).toBeGreaterThan(0);
    const total = messages.reduce((n, m) => n + (m.content ?? "").length, 0);
    expect(total).toBeLessThanOrEqual(200_000);
  });

  /**
   * The recent ones are spared even when sparing them means the ceiling cannot be met. Re-fetching what the
   * model is reasoning about right now would pay the cost this exists to avoid, twice.
   */
  it("stops at the ones it must keep, rather than meeting the number", () => {
    const { messages } = compact(big(), 10_000);
    const kept = messages.filter((m) => m.role === "tool" && (m.content ?? "").length > 1_000);
    expect(kept).toHaveLength(KEEP_RECENT_RESULTS);
  });

  /** The last few are what the model is reasoning about now; putting those away pays the cost twice. */
  it("never touches the most recent results", () => {
    const { messages } = compact(big(), 10_000);
    const tools = messages.filter((m) => m.role === "tool");
    for (const m of tools.slice(-KEEP_RECENT_RESULTS)) {
      expect((m.content ?? "").length).toBeGreaterThan(1_000);
    }
  });

  /**
   * Only tool RESULTS. The system prompt, what the user said and what the assistant said are what the run
   * IS — a summary of those would be a different conversation. A tool result is the one part that can be
   * fetched again.
   */
  it("leaves every other message exactly as it was", () => {
    const before = big();
    const { messages } = compact(before, 10_000);
    for (let i = 0; i < before.length; i++) {
      if (before[i].role === "tool") continue;
      expect(messages[i]).toEqual(before[i]);
    }
  });

  it("says what was there, so the model can ask for it again", () => {
    const s = stub(tool("read_file", 23_456));
    expect(s).toContain("read_file");
    expect(s).toContain("23,456");
    expect(s).toMatch(/call it again/i);
  });

  it("does nothing at all to a conversation that fits", () => {
    const small: Message[] = [{ role: "system", content: "P" }, tool("grep", 50)];
    const { messages, freed } = compact(small);
    expect(freed).toBe(0);
    expect(messages).toBe(small);
  });

  /** A stub that costs as much as the content saves nothing and loses the content. */
  it("leaves small results alone even when it is over the ceiling", () => {
    const many: Message[] = Array.from({ length: 100 }, () => tool("grep", 100));
    const { messages } = compact(many, 1_000);
    expect(messages.every((m) => (m.content ?? "").length === 100)).toBe(true);
  });

  it("has a ceiling that ordinary runs stay under", () => {
    expect(MAX_CONVERSATION_CHARS).toBeGreaterThanOrEqual(250_000);
  });
});

/**
 * Putting a result away also retracts the memo's claim to still have it.
 *
 * The two mechanisms were saying opposite things about the same result. Compaction replaces it and tells the
 * agent to "call it again if you still need what it said"; `Recall` then refused the call with "its result is
 * above — read it there", pointing at the stub that had just replaced it. Neither is wrong alone; together
 * they leave the agent unable to read the file and unable to give up.
 *
 * Measured on a live planner: 502 calls, 14.4M input tokens, 106 minutes, with the prompt pinned between 215k
 * and 249k against a 250k ceiling — every turn putting away 30-150k characters and immediately refilling.
 */
describe("what compaction tells the recall memo", () => {
  const big = (n: number): string => "x".repeat(n);
  const conversation = (): Message[] => [
    { role: "system", content: "s" },
    ...Array.from({ length: 20 }, (_, i) => ([
      { role: "assistant" as const, content: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }] },
      { role: "tool" as const, toolCallId: `c${i}`, name: "read_file", key: `path:f${i}.ts`, content: big(20_000) },
    ])).flat(),
  ];

  it("names what it put away", () => {
    const { freed, forgotten } = compact(conversation());
    expect(freed).toBeGreaterThan(0);
    expect(forgotten.length).toBeGreaterThan(0);
    for (const f of forgotten) expect(f).toEqual({ tool: "read_file", key: expect.stringMatching(/^path:f\d+\.ts$/) });
  });

  /** The ones still in the conversation keep their claim — the memo is only wrong about what is gone. */
  it("leaves the results it kept alone", () => {
    const { messages, forgotten } = compact(conversation());
    const gone = new Set(forgotten.map((f) => f.key));
    for (const m of messages) {
      if (m.role !== "tool" || !m.key) continue;
      const stubbed = m.content.startsWith("[`read_file` returned");
      expect(gone.has(m.key), `${m.key} stubbed=${stubbed}`).toBe(stubbed);
    }
  });

  it("says nothing when nothing was put away", () => {
    expect(compact([{ role: "user", content: "short" }]).forgotten).toEqual([]);
  });

  /** …and the memo actually drops them, so the next call is allowed through. */
  it("lets the agent fetch again what is no longer there", async () => {
    const { Recall } = await import("../../src/agent/recall.js");
    const r = new Recall();
    r.note("read_file", "path:f0.ts");
    expect(r.saw("read_file", "path:f0.ts")).toBeDefined();
    r.forget([{ tool: "read_file", key: "path:f0.ts" }]);
    expect(r.saw("read_file", "path:f0.ts")).toBeUndefined();
  });

  it("is wired into the loop, not left to the caller", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/agent/loop.ts", "utf8");
    expect(src).toContain("recall.forget(packed.forgotten)");
    // …and the result carries its identity onto the message, or there is nothing to forget it by.
    expect(src).toContain("...(r.key ? { key: r.key } : {})");
  });
});
