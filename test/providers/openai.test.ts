import { describe, it, expect } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIBody,
  mapFinishReason,
} from "../../src/providers/openai.js";
import type { ChatRequest } from "../../src/core/types.js";

describe("toOpenAIMessages", () => {
  it("maps assistant tool calls to tool_calls[]", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: '{"p":"a"}' }] },
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } }],
      },
    ]);
  });

  it("maps a tool result message via tool_call_id", () => {
    const out = toOpenAIMessages([{ role: "tool", content: "ok", toolCallId: "c1", name: "read" }]);
    expect(out).toEqual([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  });

  it("passes a plain user message through unchanged", () => {
    expect(toOpenAIMessages([{ role: "user", content: "hello" }])).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("maps a user message with images to multimodal content parts (text first, then image_url)", () => {
    const url = "data:image/png;base64,AAAA";
    expect(toOpenAIMessages([{ role: "user", content: "look", images: [url] }])).toEqual([
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url } },
      ] },
    ]);
  });

  it("omits the text part when a user image message has empty content", () => {
    const url = "data:image/png;base64,BBBB";
    expect(toOpenAIMessages([{ role: "user", content: "", images: [url] }])).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url } }] },
    ]);
  });
});

describe("toOpenAITools", () => {
  it("returns undefined for an empty list", () => {
    expect(toOpenAITools([])).toBeUndefined();
  });
  it("wraps tools in the function schema", () => {
    expect(toOpenAITools([{ name: "read", description: "read", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "read", description: "read", parameters: { type: "object" } } },
    ]);
  });
});

describe("toOpenAIBody", () => {
  it("adds no tools/tool_choice when there are no tools, stream:true remains", () => {
    const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };
    const body = toOpenAIBody(req);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("adds tool_choice:auto and parallel_tool_calls when tools are present", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read", description: "read", parameters: {} }],
    };
    const body = toOpenAIBody(req);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe("mapFinishReason", () => {
  it("passes known values through", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("stop")).toBe("stop");
  });
  it("falls back unknown/null to stop", () => {
    expect(mapFinishReason("content_filter")).toBe("stop");
    expect(mapFinishReason(null)).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
  });
});
