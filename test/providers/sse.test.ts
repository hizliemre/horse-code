import { describe, it, expect } from "vitest";
import { parseSSE, type SSELine } from "../../src/providers/sse.js";

// Produces an in-memory SSE body (no network).
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<SSELine>): Promise<SSELine[]> {
  const out: SSELine[] = [];
  for await (const x of iter) out.push(x);
  return out;
}
const data = (value: string): SSELine => ({ kind: "data", value });
const comment = (value: string): SSELine => ({ kind: "comment", value });

describe("parseSSE", () => {
  it("yields the payload of data lines, stops at [DONE]", async () => {
    const body = streamFrom([
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseSSE(body))).toEqual([data('{"a":1}'), data('{"a":2}')]);
  });

  it("joins a line split across a chunk boundary", async () => {
    const body = streamFrom(['data: {"a":', "1}\n", "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual([data('{"a":1}')]);
  });

  it("yields comment lines (omniroute ships real usage as comments); skips empty lines", async () => {
    const body = streamFrom([": keep-alive\n", "\n", 'data: {"x":true}\n', "data: [DONE]\n"]);
    expect(await collect(parseSSE(body))).toEqual([comment("keep-alive"), data('{"x":true}')]);
  });

  it("emits the buffered payload when the last line has no newline and [DONE] never arrives", async () => {
    const body = streamFrom(['data: {"z":9}']);
    expect(await collect(parseSSE(body))).toEqual([data('{"z":9}')]);
  });
});
