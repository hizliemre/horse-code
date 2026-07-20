import { describe, it, expect } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIBody,
  mapFinishReason,
} from "../../src/providers/openai.js";
import type { ChatRequest } from "../../src/core/types.js";

describe("toOpenAIMessages", () => {
  it("assistant tool çağrılarını tool_calls[] olarak eşler", () => {
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

  it("tool sonucu mesajını tool_call_id ile eşler", () => {
    const out = toOpenAIMessages([{ role: "tool", content: "ok", toolCallId: "c1", name: "read" }]);
    expect(out).toEqual([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  });

  it("düz user mesajını olduğu gibi taşır", () => {
    expect(toOpenAIMessages([{ role: "user", content: "merhaba" }])).toEqual([
      { role: "user", content: "merhaba" },
    ]);
  });
});

describe("toOpenAITools", () => {
  it("boş listede undefined döner", () => {
    expect(toOpenAITools([])).toBeUndefined();
  });
  it("tool'ları function şemasına sarar", () => {
    expect(toOpenAITools([{ name: "read", description: "oku", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "read", description: "oku", parameters: { type: "object" } } },
    ]);
  });
});

describe("toOpenAIBody", () => {
  it("tool yokken tools/tool_choice eklemez, stream:true kalır", () => {
    const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], tools: [] };
    const body = toOpenAIBody(req);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("tool varken tool_choice:auto ve parallel_tool_calls ekler", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read", description: "oku", parameters: {} }],
    };
    const body = toOpenAIBody(req);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe("mapFinishReason", () => {
  it("bilinen değerleri geçirir", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("stop")).toBe("stop");
  });
  it("bilinmeyen/null'ı stop'a düşürür", () => {
    expect(mapFinishReason("content_filter")).toBe("stop");
    expect(mapFinishReason(null)).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
  });
});
