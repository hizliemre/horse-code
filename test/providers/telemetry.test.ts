import { describe, it, expect } from "vitest";
import { telemetryProvider } from "../../src/providers/telemetry.js";
import { Telemetry } from "../../src/obs/telemetry.js";
import type { EventRecord } from "../../src/obs/telemetry.js";
import { MemorySink } from "../../src/obs/sink.js";
import type { ChatEvent, Provider } from "../../src/core/types.js";

const provider = (events: ChatEvent[]): Provider => ({
  async *chat() { for (const e of events) yield e; },
});
const req = { model: "cc/claude-opus-4-8", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const drain = async (p: Provider): Promise<void> => {
  for await (const _ of p.chat(req as never, new AbortController().signal)) { /* consume */ }
};
const chatEvents = (s: MemorySink): EventRecord[] =>
  s.records.filter((r): r is EventRecord => r.kind === "event" && r.name === "gen_ai.chat");

/**
 * A wrapper, not instrumentation at the call sites: every model call goes through `Provider.chat`, so one
 * place catches all of them and no future call site can forget. Attributes follow OTel's GenAI conventions,
 * so a dashboard built for LLM applications reads this log without a translation layer.
 */
describe("telemetryProvider", () => {
  it("records the model, the tokens and how the call ended", async () => {
    const sink = new MemorySink();
    const p = telemetryProvider(provider([
      { type: "text-delta", text: "hello" },
      { type: "usage", promptTokens: 1200, completionTokens: 34, cachedTokens: 900 },
      { type: "done", finishReason: "stop" },
    ]), new Telemetry(sink));
    await drain(p);
    expect(chatEvents(sink)[0].attributes).toMatchObject({
      "gen_ai.request.model": "cc/claude-opus-4-8",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 34,
      "gen_ai.usage.cached_tokens": 900,
      "gen_ai.response.finish_reason": "stop",
      "hc.status": "ok",
    });
  });

  it("counts what the model asked for, not just what it said", async () => {
    const sink = new MemorySink();
    const p = telemetryProvider(provider([
      { type: "tool-call", toolCall: { id: "1", name: "read_file", arguments: "{}" } },
      { type: "tool-call", toolCall: { id: "2", name: "grep", arguments: "{}" } },
      { type: "done", finishReason: "tool_calls" },
    ]), new Telemetry(sink));
    await drain(p);
    expect(chatEvents(sink)[0].attributes["hc.tools_requested"]).toBe(2);
  });

  it("records a failed call as one", async () => {
    const sink = new MemorySink();
    const p = telemetryProvider(provider([{ type: "error", message: "429 Too Many Requests" }]), new Telemetry(sink));
    await drain(p);
    expect(chatEvents(sink)[0].attributes).toMatchObject({ "hc.status": "error" });
    expect(String(chatEvents(sink)[0].attributes["hc.error"])).toContain("429");
  });

  /**
   * The record closes when the STREAM is done, not when `chat` returns: a streaming call returns its
   * generator immediately, and the time that matters is spent draining it.
   */
  it("measures the time spent streaming, not the time to get a generator", async () => {
    const sink = new MemorySink();
    const slow: Provider = {
      async *chat() {
        await new Promise((r) => setTimeout(r, 60));
        yield { type: "done", finishReason: "stop" } as ChatEvent;
      },
    };
    await drain(telemetryProvider(slow, new Telemetry(sink)));
    expect(Number(chatEvents(sink)[0].attributes["hc.duration_ms"])).toBeGreaterThanOrEqual(50);
  });

  it("passes every event through untouched", async () => {
    const events: ChatEvent[] = [
      { type: "text-delta", text: "a" },
      { type: "done", finishReason: "stop" },
    ];
    const out: ChatEvent[] = [];
    for await (const e of telemetryProvider(provider(events), new Telemetry(new MemorySink()))
      .chat(req as never, new AbortController().signal)) out.push(e);
    expect(out).toEqual(events);
  });
});

/**
 * The finished record is written when the stream closes, so a call that never closes left no trace at all —
 * and that is precisely the case worth seeing.
 */
describe("a call is recorded when it starts, not only when it ends", () => {
  const startEvents = (s: MemorySink): EventRecord[] =>
    s.records.filter((r): r is EventRecord => r.kind === "event" && r.name === "gen_ai.chat.start");

  it("records the start before any of the stream has arrived", async () => {
    const sink = new MemorySink();
    const stream = telemetryProvider(provider([{ type: "done", finishReason: "stop" }]), new Telemetry(sink))
      .chat(req as never, new AbortController().signal);
    for await (const _ of stream) break; // one event pulled — the start must already be on the log
    expect(startEvents(sink)).toHaveLength(1);
    expect(startEvents(sink)[0].attributes["gen_ai.request.model"]).toBe("cc/claude-opus-4-8");
  });

  /** Paired, so a reader can subtract the finishes from the starts and name what is still out. */
  it("gives the start and its finish the same id", async () => {
    const sink = new MemorySink();
    await drain(telemetryProvider(provider([{ type: "done", finishReason: "stop" }]), new Telemetry(sink)));
    const started = startEvents(sink)[0].attributes["hc.call_id"];
    const finished = chatEvents(sink)[0].attributes["hc.call_id"];
    expect(started).toBeDefined();
    expect(finished).toBe(started);
  });

  it("leaves the start unmatched when the stream never closes", async () => {
    const sink = new MemorySink();
    const hanging: Provider = { async *chat() { await new Promise(() => undefined); yield { type: "done", finishReason: "stop" } as ChatEvent; } };
    void (async () => {
      for await (const _ of telemetryProvider(hanging, new Telemetry(sink)).chat(req as never, new AbortController().signal)) break;
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(startEvents(sink)).toHaveLength(1);
    expect(chatEvents(sink)).toHaveLength(0); // nothing finished — which is the whole point
  });
});
