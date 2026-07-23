import type { ChatEvent, ChatRequest, Provider, ToolCall } from "../core/types.js";
import { parseSSE } from "./sse.js";
import { toOpenAIBody, mapFinishReason } from "./openai.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OmniRouteOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: FetchLike;
  idleTimeoutMs?: number; // abort a stream that goes silent this long (guards against indefinite hangs)
}

/**
 * Wraps an async iterable with an idle-timeout: if no value arrives within `idleMs`, it invokes `onIdle`
 * (to abort the underlying request) and throws — turning a silent, indefinite stream stall into a real error.
 */
export async function* withIdleTimeout<T>(source: AsyncIterable<T>, idleMs: number, onIdle?: () => void): AsyncIterable<T> {
  const it = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<"idle">((resolve) => { timer = setTimeout(() => resolve("idle"), idleMs); });
    const next = it.next();
    next.catch(() => { /* the timeout may win first — don't leak an unhandled rejection */ });
    const winner = await Promise.race([next, idle]);
    if (timer) clearTimeout(timer);
    if (winner === "idle") {
      onIdle?.(); // abort the underlying request → in production this unblocks the pending read
      // Fire-and-forget cleanup: do NOT await it.return() — the generator is parked on a read that may
      // never settle, so awaiting would hang the very timeout we're enforcing.
      void Promise.resolve(it.return?.(undefined)).catch(() => { /* ignore */ });
      throw new Error(`omniroute: stream stalled (no data for ${Math.round(idleMs / 1000)}s) — aborted`);
    }
    if (winner.done) return;
    yield winner.value;
  }
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

/**
 * A response status a fallback model might survive: 429 (source rate-limited / subscription exhausted) or
 * any 5xx (upstream down/overloaded). Auth/validation errors (400/401/403) are the caller's fault — no
 * fallback will fix them, so they stay non-retryable.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * A 400 that reflects THIS model/subscription's capability limits rather than a malformed request — e.g.
 * "long context beta not available for this subscription", context-window overflow, or an unsupported feature.
 * A fallback model on a different subscription may well accept the same request, so treat these as retryable.
 */
export function isCapabilityError(message: string): boolean {
  return /long[- ]context|not (yet )?available for this subscription|context[- ](length|window)|too many tokens|maximum context|unsupported|not supported/i.test(message);
}

export class OmniRouteProvider implements Provider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly idleMs: number;

  constructor(opts: OmniRouteOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.idleMs = opts.idleTimeoutMs ?? 120_000; // 2 min of total silence → treat as a hang
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    // Abort the request when EITHER the caller aborts (Ctrl+C) OR the stream goes idle too long.
    const idleAc = new AbortController();
    const combined = AbortSignal.any([signal, idleAc.signal]);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(toOpenAIBody(req)),
        signal: combined,
      });
    } catch (e) {
      // Network/connection failure (DNS, refused, reset) — transient; a fallback may connect.
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      return;
    }

    if (!res.ok) {
      const message = await readErrorMessage(res);
      yield { type: "error", message, retryable: isRetryableStatus(res.status) || isCapabilityError(message) };
      return;
    }
    const stream = res.body;
    if (!stream) {
      yield { type: "error", message: "omniroute: empty response body" };
      return;
    }

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: "stop" | "tool_calls" | "length" = "stop";
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    // omniroute appends the REAL billed token counts as trailing SSE comments (":
    // x-omniroute-tokens-in=48"). The stream's own usage chunk counts the full prompt the model saw —
    // including the large Claude Code system prompt omniroute injects for cc/claude providers, most of
    // which is prompt-cached and barely billed. So the comment counts are the truthful cost signal.
    const billed: { in?: number; out?: number } = {};

    try {
      // Idle-timeout guard: if omniroute/the upstream model stalls mid-stream, abort instead of hanging.
      for await (const line of withIdleTimeout(parseSSE(stream), this.idleMs, () => idleAc.abort())) {
        if (line.kind === "comment") {
          const m = line.value.match(/^x-omniroute-tokens-(in|out)\s*=\s*(\d+)/i);
          if (m) billed[m[1] === "in" ? "in" : "out"] = Number(m[2]);
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(line.value);
        } catch {
          continue; // malformed chunk → skip
        }
        // Usage arrives (with include_usage) in a final chunk whose `choices` is empty → read it before
        // the no-choice skip below.
        const u = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (u) usage = { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };
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
      // Mid-stream failure or idle-timeout stall — transient; a fallback may complete.
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      return;
    }

    for (const acc of toolCalls.values()) {
      const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: acc.arguments };
      yield { type: "tool-call", toolCall };
    }

    // Usage priority: real billed (SSE comments) → stream usage chunk → response headers. The billed
    // comments reflect actual cost (post-cache), so they win over the stream's inflated prompt count.
    if (billed.in !== undefined || billed.out !== undefined) {
      yield { type: "usage", promptTokens: billed.in ?? 0, completionTokens: billed.out ?? 0 };
    } else if (usage) {
      yield { type: "usage", promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
    } else {
      const inHeader = res.headers.get("X-OmniRoute-Tokens-In");
      const outHeader = res.headers.get("X-OmniRoute-Tokens-Out");
      if (inHeader !== null || outHeader !== null) {
        yield {
          type: "usage",
          promptTokens: Number(inHeader) || 0,
          completionTokens: Number(outHeader) || 0,
        };
      }
    }

    yield { type: "done", finishReason };
  }
}
