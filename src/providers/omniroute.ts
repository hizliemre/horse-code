import type { ChatEvent, ChatRequest, Provider, ToolCall } from "../core/types.js";
import { parseSSE } from "./sse.js";
import { toOpenAIBody, mapFinishReason } from "./openai.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OmniRouteOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: FetchLike;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Reduces omniroute's INCONSISTENT error body to a single message:
 *  - 401: { "error": "<string>" }
 *  - other: { "error": { "message": "..." } }
 *  - if not JSON / no suitable field: "omniroute <status>"
 */
export async function readErrorMessage(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return `omniroute ${res.status}`;
  }
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return `omniroute ${res.status}`;
}

export class OmniRouteProvider implements Provider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OmniRouteOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(toOpenAIBody(req)),
        signal,
      });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    if (!res.ok) {
      yield { type: "error", message: await readErrorMessage(res) };
      return;
    }
    const stream = res.body;
    if (!stream) {
      yield { type: "error", message: "omniroute: empty response body" };
      return;
    }

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: "stop" | "tool_calls" | "length" = "stop";

    try {
      for await (const payload of parseSSE(stream)) {
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // malformed chunk → skip
        }
        const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
          | { delta?: Record<string, unknown>; finish_reason?: string | null }
          | undefined;
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length) {
          yield { type: "text-delta", text: delta.content };
        }

        const deltaCalls = delta.tool_calls as
          | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          | undefined;
        if (Array.isArray(deltaCalls)) {
          for (const tc of deltaCalls) {
            const idx = tc.index ?? 0;
            const acc = toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolCalls.set(idx, acc);
          }
        }

        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      }
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    for (const acc of toolCalls.values()) {
      const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: acc.arguments };
      yield { type: "tool-call", toolCall };
    }

    const inHeader = res.headers.get("X-OmniRoute-Tokens-In");
    const outHeader = res.headers.get("X-OmniRoute-Tokens-Out");
    if (inHeader !== null || outHeader !== null) {
      yield {
        type: "usage",
        promptTokens: Number(inHeader) || 0,
        completionTokens: Number(outHeader) || 0,
      };
    }

    yield { type: "done", finishReason };
  }
}
