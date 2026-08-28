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

/**
 * The silence that is EARLIER than any stream.
 *
 * `withIdleTimeout` wraps the response body, so it cannot start until there is a body. Measured live: a
 * gateway accepted the connection for `antigravity/gemini-3.5-flash-medium` and sent nothing at all — no
 * data, no headers, no status. `fetch` never settled, the idle guard never began, and the refine phase sat
 * at 4m47s against a 2-minute budget while `cc/claude-opus-5` answered the same gateway in 1.9 seconds.
 */
describe("OmniRouteProvider — a server that never answers at all", () => {
  const neverAnswers: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      // A real fetch rejects when its signal aborts; nothing else ever settles it.
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  it("gives up instead of waiting forever for the first byte", async () => {
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch: neverAnswers, idleTimeoutMs: 40 });
    const events: ChatEvent[] = [];
    for await (const e of provider.chat(req, new AbortController().signal)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: true });
    expect((events[0] as { message: string }).message).toMatch(/nothing at all/);
  });

  /** Retryable, because a source that stopped answering is precisely what a fallback chain is for. */
  it("marks it retryable so the chain moves to the next model", async () => {
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch: neverAnswers, idleTimeoutMs: 20 });
    const events: ChatEvent[] = [];
    for await (const e of provider.chat(req, new AbortController().signal)) events.push(e);
    expect(events[0]).toMatchObject({ retryable: true });
  });

  /**
   * Ctrl+C during that same silence is the user's decision, not a fault: no fallback, no benching. The two
   * arrive as the same aborted fetch, so the difference has to be read from WHOSE signal fired.
   */
  it("still calls a caller's cancellation what it is", async () => {
    const ac = new AbortController();
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch: neverAnswers, idleTimeoutMs: 10_000 });
    const events: ChatEvent[] = [];
    setTimeout(() => ac.abort(), 20);
    for await (const e of provider.chat(req, ac.signal)) events.push(e);
    expect(events[0]).toEqual({ type: "error", message: "cancelled", retryable: false });
  });
});
