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

describe("OmniRouteProvider — usage header'ları", () => {
  it("usage header'larını done'dan önce usage event'i olarak yayar", async () => {
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
});
