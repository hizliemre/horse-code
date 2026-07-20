import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";
import { parseSSE } from "./sse.js";
import { toOpenAIBody, mapFinishReason } from "./openai.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OmniRouteOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: FetchLike;
}

/**
 * omniroute'un TUTARSIZ hata gövdesini tek mesaja indirger:
 *  - 401: { "error": "<string>" }
 *  - diğer: { "error": { "message": "..." } }
 *  - JSON değilse / uygun alan yoksa: "omniroute <status>"
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
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); // sondaki slash'ı at
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
      yield { type: "error", message: "omniroute: boş yanıt gövdesi" };
      return;
    }

    let finishReason: "stop" | "tool_calls" | "length" = "stop";

    for await (const payload of parseSSE(stream)) {
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // bozuk chunk → atla
      }
      const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
        | { delta?: Record<string, unknown>; finish_reason?: string | null }
        | undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length) {
        yield { type: "text-delta", text: delta.content };
      }

      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
    }

    yield { type: "done", finishReason };
  }
}
