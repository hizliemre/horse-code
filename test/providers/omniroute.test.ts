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

describe("OmniRouteProvider — metin streaming + hata", () => {
  it("delta.content'leri text-delta olarak yayar ve done ile biter", async () => {
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

  it("istek gövdesini ve Bearer header'ını doğru kurar", async () => {
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

  it("!res.ok durumunda stream açmadan tek error event'i yayar", async () => {
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const provider = new OmniRouteProvider({ apiKey: "bad", baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Unauthorized" }]);
  });

  it("fetch reddi (abort/ağ) tek error event'ine dönüşür", async () => {
    const fetch: FetchLike = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "The operation was aborted." }]);
  });

  it("stream ortasında hata (abort/ağ kopması) throw etmez, error event'ine döner", async () => {
    const fetch: FetchLike = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n',
            ),
          );
          // Reader'ın kuyruktaki chunk'ı önce tüketip yield etmesi için bir makro-görev
          // (setTimeout) bekle; chat() içinde `await this.fetchFn(...)` gibi ek mikro-görev
          // turları olduğundan, sadece bir mikro-görev bekletmek chunk enqueue edilir
          // edilmez controller.error()'ın kuyruğu (ResetQueue) temizlemesine yol açıp
          // "hi" chunk'ını kaybettirebiliyor (bkz. Node/undici stream davranışı).
          setTimeout(() => c.error(new Error("stream boom")), 0);
        },
      });
      return new Response(body, { status: 200 });
    };
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "error", message: "stream boom" },
    ]);
  });
});
