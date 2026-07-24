import type { ChatRequest, Message } from "../core/types.js";

/**
 * A tool call's arguments must serialize to a JSON OBJECT. A model sometimes emits a no-arg call with empty
 * or malformed arguments (""); replaying that verbatim makes providers reject the whole conversation with
 * "tool_use.input: Input should be an object". Coerce anything that isn't a plain object to "{}".
 */
function objectArgs(args: string | undefined): string {
  if (!args || !args.trim()) return "{}";
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? args : "{}";
  } catch {
    return "{}";
  }
}

export function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: objectArgs(tc.arguments) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    // Images → OpenAI multimodal content parts (text first, then each image as image_url data URI).
    if (m.images?.length) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
      const withImg: Record<string, unknown> = { role: m.role, content: parts };
      if (m.name) withImg.name = m.name;
      return withImg;
    }
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) base.name = m.name;
    return base;
  });
}

export function toOpenAITools(
  tools: ChatRequest["tools"],
): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toOpenAIBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    stream: true,
    // Ask the backend to append a final chunk carrying token usage (streaming otherwise omits it).
    stream_options: { include_usage: true },
  };
  const tools = toOpenAITools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

export function mapFinishReason(
  reason: string | null | undefined,
): "stop" | "tool_calls" | "length" {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return "stop"; // stop | content_filter | null | undefined → stop
}
