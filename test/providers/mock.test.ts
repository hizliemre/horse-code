import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (model: string): ChatRequest => ({ model, messages: [], tools: [] });

describe("MockProvider", () => {
  it("emits the next turn on each chat call and records requests", async () => {
    const p = new MockProvider([
      [{ type: "text-delta", text: "a" }, { type: "done", finishReason: "stop" }],
      [{ type: "text-delta", text: "b" }, { type: "done", finishReason: "stop" }],
    ]);
    expect(await drain(p.chat(req("m1"), new AbortController().signal))).toEqual([
      { type: "text-delta", text: "a" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(await drain(p.chat(req("m2"), new AbortController().signal))).toEqual([
      { type: "text-delta", text: "b" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(p.requests.map((r) => r.model)).toEqual(["m1", "m2"]);
  });

  it("emits a default done once turns are exhausted", async () => {
    const p = new MockProvider([]);
    expect(await drain(p.chat(req("m"), new AbortController().signal))).toEqual([
      { type: "done", finishReason: "stop" },
    ]);
  });
});
