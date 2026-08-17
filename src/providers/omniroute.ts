import type { ChatEvent, ChatRequest, Provider, ToolCall } from "../core/types.js";
import { parseSSE } from "./sse.js";
import { toOpenAIBody, mapFinishReason } from "./openai.js";
import { toAnthropicBody, isAnthropicModel, AnthropicDecoder } from "./anthropic.js";
import { sanitizeForJson } from "../core/surrogates.js";

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
 * A response status a fallback model might survive: 429 (source rate-limited / subscription exhausted),
 * 404 (the requested MODEL isn't available on this subscription — every request here is a model chat
 * completion, so a 404 means model-not-found, not a bad route), or any 5xx (upstream down/overloaded).
 * Auth/validation errors (400/401/403) are the caller's fault — no fallback will fix them, so they stay
 * non-retryable.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 404 || status >= 500;
}

/**
 * A 400 that reflects THIS model/subscription's capability limits rather than a malformed request — e.g.
 * "long context beta not available for this subscription", context-window overflow, or an unsupported feature.
 * A fallback model on a different subscription may well accept the same request, so treat these as retryable.
 */
export function isCapabilityError(message: string): boolean {
  return /long[- ]context|not (yet )?available for this subscription|context[- ](length|window)|too many tokens|maximum context|unsupported|not supported/i.test(message);
}

/**
 * The gateway could not resolve the MODEL ID it was given.
 *
 * "Unable to determine provider for model 'default'" is a statement about the id, not about any model's
 * health — and the id in it is usually not even one of the models the failing role was assigned. Benching on
 * it is how one bad id took the whole pool down: each failure quarantined three working models and re-chained
 * fifty-eight roles onto a shrinking pool, which produced the next failure. Falling to the next model is
 * still right; writing this one off is not.
 */
export function isUnknownModelError(message: string): boolean {
  return /unable to determine provider for model|unknown model|model not found|no such model|invalid model/i.test(message);
}

/** Best-effort extraction of a "path" field from partial tool-call JSON args (for live write progress). */
function pathOf(args: string): string | undefined {
  return args.match(/"path"\s*:\s*"([^"\\]+)"/)?.[1];
}

/**
 * Whether a tool call's accumulated arguments are a WHOLE argument object.
 *
 * They are accumulated one delta at a time, so a stream that stops early leaves a valid prefix of JSON and
 * nothing to distinguish it from a stream that finished. Empty is not truncation: a tool with no arguments
 * sends none, and the executor reads that as `{}`.
 */
function argumentsComplete(args: string): boolean {
  if (!args.trim()) return true;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}


/**
 * Whether a thrown error is the CALLER's cancellation rather than a fault.
 *
 * Both are delivered as an aborted fetch, so without this a user pressing Ctrl+C looked exactly like a model
 * that had died: the abort became a retryable error, the retryable error benched the model, and the roles
 * using it were re-assigned. The user cancelled and was told their model had failed.
 *
 * The idle-timeout abort is deliberately NOT this: nothing arriving for two minutes is a real transport
 * failure and a fallback may well complete the same request.
 */
/**
 * A caller's cancellation, as distinct from a deadline of ours running out.
 *
 * Both abort the same signal, and treating them alike is wrong in two ways at once: our own deadline is
 * reported to the user as "cancelled" — a word that says a person did it — and it is marked NON-retryable,
 * so the chain never tries the next model even though another one might answer in time.
 *
 * Every deadline in the pipeline arrives this way: the implementer's budget, a review's timeout, a short
 * call's own limit are all composed onto the caller's signal, so every one of them was being read as the
 * user pressing Ctrl+C.
 *
 * `AbortSignal.any` keeps the reason of whichever source fired, so the two are actually distinguishable:
 * a timeout leaves a `TimeoutError`, a caller's `abort()` leaves an `AbortError`.
 */
function isCallerAbort(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name !== "TimeoutError";
}

/** Our own deadline, not the caller's decision — worth saying differently and worth retrying elsewhere. */
function isDeadline(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
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
    /**
     * Anthropic's own schema for Anthropic's own models, the OpenAI-compatible one for everything else.
     *
     * Not a preference: `output_config.effort` is dropped in silence by the compatible endpoint, so a Claude
     * model can only be told how hard to work through this door. Measured — see src/providers/anthropic.ts.
     * Everything else about the two paths is the same from here: same SSE, same billed-token comments.
     */
    const native = isAnthropicModel(req.model);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (native) headers["anthropic-version"] = "2023-06-01";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    // Abort the request when EITHER the caller aborts (Ctrl+C) OR the stream goes idle too long.
    const idleAc = new AbortController();
    const combined = AbortSignal.any([signal, idleAc.signal]);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${native ? "/v1/messages" : "/api/v1/chat/completions"}`, {
        method: "POST",
        headers,
        // Sanitised at the socket, not at each of the dozens of places that build a prompt — see
        // src/core/surrogates.ts for the four-hour run this cost.
        body: JSON.stringify(sanitizeForJson(native ? toAnthropicBody(req) : toOpenAIBody(req))),
        signal: combined,
      });
    } catch (e) {
      // The caller cancelling is not a failure of anything: no fallback, no benching.
      if (isCallerAbort(signal)) { yield { type: "error", message: "cancelled", retryable: false }; return; }
      // A deadline is OURS. Another model in the chain may answer inside it, so this is retryable.
      if (isDeadline(signal)) { yield { type: "error", message: "the model did not answer within its deadline", retryable: true }; return; }
      // Network/connection failure (DNS, refused, reset) — transient; a fallback may connect.
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      return;
    }

    if (!res.ok) {
      const message = await readErrorMessage(res);
      const capability = isCapabilityError(message);
      const unknownModel = isUnknownModelError(message);
      // Only present when it IS one: the flag means something in the affirmative, and emitting it on every
      // error would put a field in the shape that says nothing.
      yield {
        type: "error", message,
        retryable: isRetryableStatus(res.status) || capability || unknownModel,
        ...(capability && { capability: true }),
        ...(unknownModel && { noBench: true }),
      };
      return;
    }
    const stream = res.body;
    if (!stream) {
      yield { type: "error", message: "omniroute: empty response body" };
      return;
    }

    // The native path decodes its own event stream; the OpenAI path accumulates below. See AnthropicDecoder.
    const decoder = native ? new AnthropicDecoder() : undefined;
    const toolCalls = new Map<number, ToolCallAccumulator>();
    const lastProgress = new Map<number, number>(); // per tool-call: last arg length we emitted progress for
    let finishReason: "stop" | "tool_calls" | "length" = "stop";
    let sawText = false;
    let usage: { promptTokens: number; completionTokens: number; cachedTokens: number } | undefined;
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
        if (decoder) {
          for (const ev of decoder.push(chunk)) yield ev;
          continue;
        }
        // Usage arrives (with include_usage) in a final chunk whose `choices` is empty → read it before
        // the no-choice skip below.
        const u = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage;
        // cached_tokens is the share of the prompt the backend served from its prefix cache. Without reading
        // it, a re-sent 40k-token conversation looks identical in cost to a fresh one — so the headline number
        // overstated what was actually billed, and there was no way to tell by how much.
        if (u) usage = {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        };
        const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
          | { delta?: Record<string, unknown>; finish_reason?: string | null }
          | undefined;
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length) {
          sawText = true;
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
            // Live progress every ~64 chars so the UI can show the file growing instead of a silent wait.
            if (acc.name && acc.arguments.length - (lastProgress.get(idx) ?? 0) >= 64) {
              lastProgress.set(idx, acc.arguments.length);
              yield { type: "tool-progress", name: acc.name, chars: acc.arguments.length, path: pathOf(acc.arguments) };
            }
          }
        }

        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      }
    } catch (e) {
      if (isCallerAbort(signal)) { yield { type: "error", message: "cancelled", retryable: false }; return; }
      // A deadline is OURS. Another model in the chain may answer inside it, so this is retryable.
      if (isDeadline(signal)) { yield { type: "error", message: "the model did not answer within its deadline", retryable: true }; return; }
      // Mid-stream failure or idle-timeout stall — transient; a fallback may complete.
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      return;
    }

    /**
     * A tool call whose arguments never became whole JSON is a stream that stopped, not a call the model made.
     *
     * Measured on a live feature run: `cx/gpt-5.6-luna-max` streamed one `write_file` for 155 seconds and then
     * the stream simply ended — no `finish_reason` in any chunk, no usage chunk, no billed comment, no text
     * (`hc.text_chars: 0`). Half a JSON object was handed to the agent as "arguments are invalid JSON", and
     * 155 seconds of a spec file was gone. The transport reported the turn as `ok`.
     *
     * Reported as a retryable error instead, this is exactly the shape the chain already recovers from: an
     * error before anything streamed retries the SAME turn on the next model (see src/agent/loop.ts). Only
     * while nothing streamed — once text is out the turn cannot be re-run, and telling the model its call
     * arrived broken is the better of the two remaining moves.
     */
    const cut = sawText ? undefined : [...toolCalls.values()].find((a) => !argumentsComplete(a.arguments));
    if (cut) {
      yield {
        type: "error",
        message: `the stream ended in the middle of ${cut.name || "a tool call"}'s arguments`,
        retryable: true,
      };
      return;
    }
    for (const acc of toolCalls.values()) {
      const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: acc.arguments };
      yield { type: "tool-call", toolCall };
    }
    if (decoder) {
      finishReason = decoder.finishReason();
      usage = decoder.usage() ?? usage;
    }

    // Usage priority: real billed (SSE comments) → stream usage chunk → response headers. The billed
    // comments reflect actual cost (post-cache), so they win over the stream's inflated prompt count.
    if (billed.in !== undefined || billed.out !== undefined) {
      yield { type: "usage", promptTokens: billed.in ?? 0, completionTokens: billed.out ?? 0 };
    } else if (usage) {
      yield { type: "usage", promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cachedTokens: usage.cachedTokens };
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
