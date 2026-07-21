import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };

describe("OmniRouteProvider — usage", () => {
  it("emits usage headers as a usage event before done", async () => {
    const fetch: FetchLike = async () =>
      sseResponse(
        ['data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n', "data: [DONE]\n"],
        { "X-OmniRoute-Tokens-In": "12", "X-OmniRoute-Tokens-Out": "5" },
      );
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "usage", promptTokens: 12, completionTokens: 5 },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("emits usage from a final stream chunk (include_usage) with empty choices", async () => {
    const fetch: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45}}\n',
        "data: [DONE]\n",
      ]);
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "usage", promptTokens: 123, completionTokens: 45 },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("stream usage wins over headers when both are present", async () => {
    const fetch: FetchLike = async () =>
      sseResponse(
        [
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n',
          "data: [DONE]\n",
        ],
        { "X-OmniRoute-Tokens-In": "1", "X-OmniRoute-Tokens-Out": "1" },
      );
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toContainEqual({ type: "usage", promptTokens: 100, completionTokens: 10 });
  });
});
