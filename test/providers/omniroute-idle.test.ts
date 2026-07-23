import { describe, it, expect } from "vitest";
import { OmniRouteProvider, withIdleTimeout, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] };

describe("withIdleTimeout", () => {
  it("passes values through and completes when data flows", async () => {
    async function* src(): AsyncGenerator<number> { yield 1; yield 2; }
    const out: number[] = [];
    for await (const v of withIdleTimeout(src(), 1000)) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it("throws (and calls onIdle) when the source stalls past the idle window", async () => {
    const stalling: AsyncIterable<number> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
    let idled = false;
    const it = withIdleTimeout(stalling, 20, () => { idled = true; })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/stalled/);
    expect(idled).toBe(true);
  });
});

describe("OmniRouteProvider — stream stall", () => {
  it("emits an error (not an infinite hang) when the stream goes silent", async () => {
    const enc = new TextEncoder();
    // one chunk, then the stream never closes → the next read hangs forever
    const stalling = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n')); },
    });
    const fetch: FetchLike = async () => new Response(stalling, { status: 200 });
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch, idleTimeoutMs: 40 });
    const events: ChatEvent[] = [];
    for await (const e of provider.chat(req, new AbortController().signal)) events.push(e);
    expect(events[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toMatch(/stalled/);
  });
});
