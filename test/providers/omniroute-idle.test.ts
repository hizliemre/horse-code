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

/**
 * A stream that is alive and producing nothing — the third case, and the one that actually hung a run.
 *
 * Measured against the live gateway: it answers in 2 seconds with `200 text/event-stream` and then sends
 * `{"id":"chatcmpl-keepalive",…}` every 2.5 seconds, indefinitely, while the upstream model produces
 * nothing. The refine phase sat at 3m30s. Both existing guards behaved exactly as designed and neither
 * could help: headers had arrived, so the first-byte timer was cleared, and the stream never went quiet,
 * so the idle timer never tripped.
 */
describe("OmniRouteProvider — a stream kept alive with nothing in it", () => {
  const keepalives = (everyMs: number): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    return new ReadableStream<Uint8Array>({
      start(c) {
        timer = setInterval(() => {
          // The shape the gateway actually sends: a chunk with an empty delta and no finish_reason.
          c.enqueue(enc.encode('data: {"id":"chatcmpl-keepalive","model":"keepalive","choices":[{"index":0,"delta":{},"finish_reason":null}]}\n'));
        }, everyMs);
      },
      cancel() { clearInterval(timer); },
    });
  };

  it("gives up on padding that never becomes output", async () => {
    const fetch: FetchLike = async () => new Response(keepalives(10), { status: 200 });
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch, idleTimeoutMs: 60 });
    const events: ChatEvent[] = [];
    const t0 = Date.now();
    for await (const e of provider.chat(req, new AbortController().signal)) events.push(e);
    expect(Date.now() - t0).toBeLessThan(2_000);          // it ended, and it ended on its own budget
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
    expect((events.at(-1) as { message: string }).message).toMatch(/without the model producing anything/);
  });

  /**
   * The budget is deliberately the same as the one for silence: a gateway padding while a reasoning model
   * thinks is legitimate, and being stricter here than there would cut short exactly that.
   */
  it("does not fire while real output keeps arriving, however slowly", async () => {
    const enc = new TextEncoder();
    let n = 0;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        const timer = setInterval(() => {
          // Two keepalives for every one real token — padding must not by itself keep the stream alive,
          // and content must not be starved by the padding around it.
          c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n'));
          c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n'));
          c.enqueue(enc.encode(`data: {"choices":[{"index":0,"delta":{"content":"t${n}"},"finish_reason":null}]}\n`));
          if (++n >= 6) { clearInterval(timer); c.enqueue(enc.encode("data: [DONE]\n")); c.close(); }
        }, 15);
      },
    });
    const fetch: FetchLike = async () => new Response(slow, { status: 200 });
    const provider = new OmniRouteProvider({ baseUrl: "http://x", fetch, idleTimeoutMs: 60 });
    const events: ChatEvent[] = [];
    for await (const e of provider.chat(req, new AbortController().signal)) events.push(e);
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("t0t1t2t3t4t5");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
