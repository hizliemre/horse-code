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

const req: ChatRequest = { model: "cc/claude-opus-4-8", messages: [{ role: "user", content: "hi" }], tools: [] };

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
    expect(sent.model).toBe("cc/claude-opus-4-8");
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
