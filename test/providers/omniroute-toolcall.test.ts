import { describe, it, expect } from "vitest";
import { OmniRouteProvider, type FetchLike } from "../../src/providers/omniroute.js";
import type { ChatEvent, ChatRequest } from "../../src/core/types.js";

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "weather" }], tools: [] };

describe("OmniRouteProvider — tool-call merging", () => {
  it("merges tool_calls arriving in fragments by index into a single event", async () => {
    const fetch: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"IST\\"}"}}]},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
        "data: [DONE]\n",
      ]);
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "call_1", name: "get_weather", arguments: '{"city":"IST"}' } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });
});

/**
 * A stream that stops part-way through a tool call's arguments used to be reported as a successful turn.
 *
 * Measured live: `cx/gpt-5.6-luna-max` streamed one `write_file` for 155 seconds and the stream ended — no
 * `finish_reason` in any chunk, no usage chunk, no billed comment, no text. Half a JSON object went to the
 * agent as "arguments are invalid JSON", the telemetry recorded `hc.status: ok`, and the work was gone.
 */
describe("a stream that ends mid-argument", () => {
  const cutOff = (lines: string[]): FetchLike => async () => sseResponse(lines);

  const truncated = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"spec.md\\",\\"content\\":\\"# Sp"}}]},"finish_reason":null}]}\n',
  ];

  it("is an error the chain can retry, not a tool call", async () => {
    const provider = new OmniRouteProvider({ baseUrl: "http://localhost:20128", fetch: cutOff(truncated) });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    expect(events[0]).toEqual({
      type: "error",
      message: "the stream ended in the middle of write_file's arguments",
      retryable: true,
    });
  });

  /**
   * Once text is out the turn cannot be re-run, and a retryable error there is fatal rather than a fallback
   * (see src/agent/loop.ts). Telling the model its call arrived broken is the better of the two moves left.
   */
  it("is left to the model when prose already streamed", async () => {
    const provider = new OmniRouteProvider({
      baseUrl: "http://localhost:20128",
      fetch: cutOff(['data: {"choices":[{"index":0,"delta":{"content":"Writing the spec."}}]}\n', ...truncated]),
    });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({ toolCall: { name: "write_file" } });
  });

  it("does not mistake a tool that takes no arguments for a cut-off one", async () => {
    const provider = new OmniRouteProvider({
      baseUrl: "http://localhost:20128",
      fetch: cutOff([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"git_status"}}]}}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      ]),
    });
    const events = await drain(provider.chat(req, new AbortController().signal));
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({ toolCall: { name: "git_status" } });
  });
});
