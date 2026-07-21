import { describe, it, expect } from "vitest";
import { meterProvider } from "../../src/providers/meter.js";
import type { Provider, ChatEvent } from "../../src/core/types.js";

function fakeProvider(events: ChatEvent[]): Provider {
  return {
    async *chat() {
      for (const ev of events) yield ev;
    },
  };
}

describe("meterProvider", () => {
  it("reports the request model + token usage for each usage event, and passes events through", async () => {
    const samples: { model: string; promptTokens: number; completionTokens: number }[] = [];
    const inner = fakeProvider([
      { type: "text-delta", text: "hi" },
      { type: "usage", promptTokens: 100, completionTokens: 40 },
      { type: "done", finishReason: "stop" },
    ]);
    const p = meterProvider(inner, (s) => samples.push(s));
    const out: ChatEvent[] = [];
    for await (const ev of p.chat({ model: "m-x", messages: [], tools: [] }, new AbortController().signal)) {
      out.push(ev);
    }
    expect(samples).toEqual([{ model: "m-x", promptTokens: 100, completionTokens: 40 }]);
    expect(out).toHaveLength(3); // all events forwarded untouched
    expect(out[0]).toEqual({ type: "text-delta", text: "hi" });
  });

  it("does not report when there is no usage event", async () => {
    const samples: unknown[] = [];
    const p = meterProvider(fakeProvider([{ type: "done", finishReason: "stop" }]), (s) => samples.push(s));
    for await (const _ of p.chat({ model: "m", messages: [], tools: [] }, new AbortController().signal)) { /* drain */ }
    expect(samples).toEqual([]);
  });
});
