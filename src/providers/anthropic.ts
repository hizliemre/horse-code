import type { ChatEvent, ChatRequest, Message } from "../core/types.js";

/**
 * Anthropic's own request shape, for the one thing the OpenAI-compatible shape cannot carry: effort.
 *
 * Measured against the running omniroute (v3.8.48) with a request that is a guaranteed upstream 400 —
 * `thinking: {type: "disabled"}` together with `output_config.effort: "max"`, which Claude Opus 5 rejects:
 *
 *   POST /api/v1/chat/completions  → 200   (so the fields never reached Anthropic)
 *   POST /v1/messages              → 400   "output_config.effort 'max' is not supported when thinking is
 *                                           disabled on this model", upstream request_id req_011Ce2iE9tLM…
 *
 * The OpenAI-compatible endpoint accepts `reasoning_effort: "bogus"` with a 200 as well: it is not
 * translating the field, it is dropping it. So every Claude role has been running at the API's default
 * effort, and no value we put in the config could have changed that.
 *
 * The native endpoint carries everything else this provider depends on: SSE with the same
 * `x-omniroute-tokens-in/out` comments the billed-usage accounting reads, tool calls (`input_json_delta`),
 * and streaming. Effort is observable end to end — the same question answered at `low` and at `max` cost 114
 * and 197 output tokens, and `high` came back with a thinking block.
 */

/** What Anthropic accepts for `output_config.effort`. Default (unset) is `high`. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * `max_tokens` is REQUIRED by the Anthropic API and absent from the OpenAI body we send today.
 *
 * So this transport has to name a number the other one never had to. 64k is the streaming default the API's
 * own guidance gives — every current Claude model reaches it (Haiku 4.5 caps there exactly, the rest at
 * 128k), and it is a ceiling rather than a target: nothing is spent for being allowed to write more.
 *
 * Erring high is the safe direction. A ceiling that is too low truncates a long implementation mid-file and
 * costs the whole attempt; one that is too high costs nothing at all.
 */
export const MAX_OUTPUT_TOKENS = 64_000;

/** Models that speak Anthropic's own schema — the ones whose effort we can actually set. */
export function isAnthropicModel(model: string): boolean {
  return /(^|\/)(claude|fable|mythos)/i.test(model) || /claude/i.test(model);
}

/** A data URI as Anthropic wants it: `{type: "base64", media_type, data}`. Undefined when it is not one. */
function imageSource(uri: string): { type: "base64"; media_type: string; data: string } | undefined {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  return m?.[1] && m[2] ? { type: "base64", media_type: m[1], data: m[2] } : undefined;
}

/** A tool call's arguments as an OBJECT. See objectArgs in openai.ts for why this coercion exists. */
function toolInput(args: string | undefined): Record<string, unknown> {
  if (!args?.trim()) return {};
  try {
    const v: unknown = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Block = Record<string, unknown>;
interface Turn { role: "user" | "assistant"; content: Block[] }

/**
 * The conversation as Anthropic wants it: a separate system prompt, and turns that alternate.
 *
 * Two shape differences do real work here. The system prompt is a top-level field rather than a message, and
 * a tool RESULT is a block inside a user turn rather than a role of its own — so a run of tool results, which
 * the agent loop pushes one message at a time, has to become ONE user turn carrying several blocks. Sent as
 * separate turns they are consecutive user messages, which the API rejects.
 */
export function toAnthropicMessages(messages: Message[]): { system: string; turns: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]): void => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content || "(no output)",
      }]);
      continue;
    }
    const blocks: Block[] = [];
    // Images first: they are what the sentence is about, and the text that names them follows it.
    for (const uri of m.images ?? []) {
      const source = imageSource(uri);
      if (source) blocks.push({ type: "image", source });
    }
    // An empty text block is rejected outright, and an assistant turn that only calls a tool has one.
    if (m.content.trim()) blocks.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: toolInput(tc.arguments) });
    }
    push(m.role === "assistant" ? "assistant" : "user", blocks);
  }
  return { system: system.join("\n\n"), turns };
}

export function toAnthropicBody(req: ChatRequest): Record<string, unknown> {
  const { system, turns } = toAnthropicMessages(req.messages);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    messages: turns,
  };
  if (system) body.system = system;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  // The whole reason this transport exists. Unset ⇒ the field is absent ⇒ the API's own default (`high`).
  if (req.effort) body.output_config = { effort: req.effort };
  return body;
}

/** Anthropic's stop reasons, in the three the rest of the system knows about. */
export function mapStopReason(reason: string | null | undefined): "stop" | "tool_calls" | "length" {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop"; // end_turn | stop_sequence | refusal | pause_turn | null
}

/** Live progress is emitted every this many characters of a tool call's arguments — as on the other path. */
const PROGRESS_EVERY = 64;

/** The `path` a partially-written tool call is about, for the live "writing <file>" line. */
function pathOf(partial: string): string | undefined {
  const m = /"(?:path|file|filename|target)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partial);
  return m?.[1] ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

interface OpenBlock { type: string; id: string; name: string; args: string; emitted: number }

/**
 * Anthropic's event stream, decoded into this system's events.
 *
 * A step function rather than a loop, so the transport keeps the fetch, the abort signals and the idle
 * guard, and this file stays pure and testable. `push` takes one already-parsed `data:` payload.
 *
 * Thinking blocks are read and dropped. They are content the model produced for itself; emitting them as
 * text would put reasoning into the answer the user reads, and into the transcript every later turn re-sends.
 */
export class AnthropicDecoder {
  private readonly blocks = new Map<number, OpenBlock>();
  private stop: "stop" | "tool_calls" | "length" = "stop";
  private inTokens = 0;
  private outTokens = 0;
  private cachedTokens = 0;
  private sawUsage = false;

  push(chunk: unknown): ChatEvent[] {
    const c = chunk as {
      type?: string;
      index?: number;
      message?: { usage?: Record<string, number> };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      usage?: Record<string, number>;
      error?: { message?: string; type?: string };
    };
    const out: ChatEvent[] = [];
    switch (c.type) {
      case "message_start": {
        const u = c.message?.usage;
        if (u) {
          this.sawUsage = true;
          this.inTokens = u.input_tokens ?? 0;
          this.cachedTokens = u.cache_read_input_tokens ?? 0;
        }
        break;
      }
      case "content_block_start": {
        const b = c.content_block;
        if (b && c.index !== undefined) {
          this.blocks.set(c.index, {
            type: b.type ?? "text", id: b.id ?? "", name: b.name ?? "", args: "", emitted: 0,
          });
        }
        break;
      }
      case "content_block_delta": {
        const b = c.index === undefined ? undefined : this.blocks.get(c.index);
        if (c.delta?.type === "text_delta" && c.delta.text) {
          out.push({ type: "text-delta", text: c.delta.text });
        } else if (c.delta?.type === "input_json_delta" && b) {
          b.args += c.delta.partial_json ?? "";
          if (b.name && b.args.length - b.emitted >= PROGRESS_EVERY) {
            b.emitted = b.args.length;
            out.push({ type: "tool-progress", name: b.name, chars: b.args.length, path: pathOf(b.args) });
          }
        }
        break;
      }
      case "content_block_stop": {
        const b = c.index === undefined ? undefined : this.blocks.get(c.index);
        if (b?.type === "tool_use") {
          out.push({ type: "tool-call", toolCall: { id: b.id, name: b.name, arguments: b.args || "{}" } });
        }
        if (c.index !== undefined) this.blocks.delete(c.index);
        break;
      }
      case "message_delta": {
        if (c.delta?.stop_reason) this.stop = mapStopReason(c.delta.stop_reason);
        if (c.usage) {
          this.sawUsage = true;
          this.outTokens = c.usage.output_tokens ?? this.outTokens;
          // Input can be restated here; take it only when message_start did not carry it.
          if (!this.inTokens) this.inTokens = c.usage.input_tokens ?? 0;
        }
        break;
      }
      case "error": {
        // A mid-stream error arrives as an event rather than a status code — surface it as one.
        out.push({ type: "error", message: c.error?.message ?? "anthropic: stream error", retryable: true });
        break;
      }
      default:
        break; // ping, message_stop, and anything added later
    }
    return out;
  }

  /** Usage as the transport should report it, or undefined when the stream never said. */
  usage(): { promptTokens: number; completionTokens: number; cachedTokens: number } | undefined {
    return this.sawUsage
      ? { promptTokens: this.inTokens, completionTokens: this.outTokens, cachedTokens: this.cachedTokens }
      : undefined;
  }

  finishReason(): "stop" | "tool_calls" | "length" {
    return this.stop;
  }
}
