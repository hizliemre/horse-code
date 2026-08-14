import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/**
 * A non-Claude model, deliberately: these cases exercise the OpenAI-compatible transport, and a Claude id
 * now takes the Anthropic one (see src/providers/anthropic.ts — it is the only door effort fits through).
 */
const req: ChatRequest = { model: "cx/gpt-5.6-terra", messages: [{ role: "user", content: "hi" }], tools: [] };

describe("OmniRouteProvider — text streaming + error", () => {
  it("emits delta.content as text-delta and ends with done", async () => {
    const fetch: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        "data: [DONE]\n",
      ]);
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("builds the request body and Bearer header correctly", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return sseResponse(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n', "data: [DONE]\n"]);
    };
    const provider = new OmniRouteProvider({ apiKey: "sk-1", baseUrl: "http://localhost:20128/", fetch });
    await drain(provider.chat(req, new AbortController().signal));
    expect(captured?.url).toBe("http://localhost:20128/api/v1/chat/completions");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");
    const sent = JSON.parse(captured?.init?.body as string);
    expect(sent.model).toBe("cx/gpt-5.6-terra");
    expect(sent.stream).toBe(true);
  });

  it("emits a single error event without opening a stream when !res.ok", async () => {
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const provider = new OmniRouteProvider({ apiKey: "bad", baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Unauthorized", retryable: false }]); // 401 → no fallback
  });

  it("converts a fetch rejection (abort/network) into a single error event", async () => {
    const fetch: FetchLike = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "The operation was aborted.", retryable: true }]); // network → retryable
  });

  it("does not throw on a mid-stream error (abort/network drop), returns an error event instead", async () => {
    const fetch: FetchLike = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n',
            ),
          );
          // Wait a macrotask (setTimeout) so the reader consumes and yields the queued
          // chunk first; since chat() has extra microtask turns like
          // `await this.fetchFn(...)`, waiting only a microtask can let controller.error()
          // clear the queue (ResetQueue) right after the chunk is enqueued, losing the
          // "hi" chunk (see Node/undici stream behavior).
          setTimeout(() => c.error(new Error("stream boom")), 0);
        },
      });
      return new Response(body, { status: 200 });
    };
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "error", message: "stream boom", retryable: true }, // mid-stream drop → retryable
    ]);
  });
});

/**
 * A caller's cancellation and a deadline of ours both abort the same signal, and treating them alike is
 * wrong twice over: our own deadline is reported as "cancelled" — a word that says a person did it — and
 * marked NON-retryable, so the chain never tries the next model even though another might answer in time.
 *
 * Every deadline in the pipeline arrives composed onto the caller's signal — the implementer's budget, a
 * review's timeout, a short call's own limit — so every one of them read as the user pressing Ctrl+C.
 */
describe("a deadline is not a cancellation", () => {
  const provider = (fetchFn: FetchLike): OmniRouteProvider =>
    new OmniRouteProvider({ apiKey: "k", baseUrl: "http://x", fetch: fetchFn });
  // A real fetch rejects when its signal aborts; the point here is what the provider makes of that.
  const hang: FetchLike = (_u, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason), { once: true });
  });

  const drain = async (p: OmniRouteProvider, signal: AbortSignal): Promise<ChatEvent[]> => {
    const out: ChatEvent[] = [];
    for await (const ev of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }, signal)) out.push(ev);
    return out;
  };

  it("says the deadline passed, and lets the chain try another model", async () => {
    const evs = await drain(provider(hang), AbortSignal.timeout(30));
    const err = evs.find((e) => e.type === "error") as { message: string; retryable: boolean } | undefined;
    expect(err?.message).toMatch(/deadline/i);
    expect(err?.retryable).toBe(true);
  });

  /** A person cancelling still ends it — trying another model would be ignoring them. */
  it("still reports a caller's cancel as cancelled, and does not retry", async () => {
    const ac = new AbortController();
    const p = drain(provider(hang), ac.signal);
    ac.abort();
    const err = (await p).find((e) => e.type === "error") as { message: string; retryable: boolean } | undefined;
    expect(err?.message).toBe("cancelled");
    expect(err?.retryable).toBe(false);
  });

  /** The composite the pipeline actually passes: the job's signal AND the call's own deadline. */
  it("tells them apart through a composed signal", async () => {
    const job = new AbortController();
    const evs = await drain(provider(hang), AbortSignal.any([job.signal, AbortSignal.timeout(30)]));
    const err = evs.find((e) => e.type === "error") as { message: string; retryable: boolean } | undefined;
    expect(err?.retryable).toBe(true); // the job was never cancelled — only our deadline passed
    expect(job.signal.aborted).toBe(false);
  });
});
