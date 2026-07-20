import { describe, it, expect } from "vitest";
import { parseSSE } from "../../src/providers/sse.js";

// Bellek içi SSE gövdesi üretir (ağ yok).
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("parseSSE", () => {
  it("data satırlarının payload'unu yield eder, [DONE]'da durur", async () => {
    const body = streamFrom([
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseSSE(body))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("chunk sınırında bölünen satırı birleştirir", async () => {
    const body = streamFrom(['data: {"a":', "1}\n", "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual(['{"a":1}']);
  });

  it("data olmayan ve boş satırları atlar", async () => {
    const body = streamFrom([": keep-alive\n", "\n", 'data: {"x":true}\n', "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual(['{"x":true}']);
  });

  it("son satırda newline yoksa ve [DONE] gelmezse, buffer'daki payload'u yayar", async () => {
    const body = streamFrom(['data: {"z":9}']);
    expect(await collect(parseSSE(body))).toEqual(['{"z":9}']);
  });
});
