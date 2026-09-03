import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  toAnthropicBody, toAnthropicMessages, mapStopReason, isAnthropicModel, isEffort,
  AnthropicDecoder, MAX_OUTPUT_TOKENS,
} from "../../src/providers/anthropic.js";
import type { ChatRequest, Message } from "../../src/core/types.js";

/**
 * A Claude model's effort is not in its name, and the OpenAI-compatible endpoint drops it in silence.
 *
 * Measured against the running omniroute (v3.8.48) with a request Claude Opus 5 is guaranteed to reject —
 * `thinking: {type: "disabled"}` together with `output_config.effort: "max"`:
 *
 *   POST /api/v1/chat/completions  → 200   (the fields never reached Anthropic)
 *   POST /v1/messages              → 400   "output_config.effort 'max' is not supported when thinking is
 *                                           disabled on this model", upstream request_id req_011Ce2iE9tLM…
 *
 * The compatible endpoint also answers 200 to `reasoning_effort: "bogus"`. It is not translating the field,
 * it is discarding it — so until this transport existed, no value in any config could change how hard a
 * Claude model worked.
 */
const req = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({ model: "cc/claude-opus-5", messages: [{ role: "user", content: "hi" }], tools: [], ...over });

/**
 * Prompt caching, which this gateway ignored when it was last measured and now honours.
 *
 * Re-measured against it on cc/claude-haiku-4-5, cc/claude-sonnet-5 and cc/claude-opus-4-8, with an
 * identical 12,352-token prefix:
 *
 *   without cache_control   input 12222 · cache_read 0     — on every one of three calls
 *   with cache_control      input    13 · cache_write 12209 → cache_read 12209
 *
 * Of one 91-minute run's 149.7M input tokens, 127M went over this path and every one was billed in full.
 */
describe("cache breakpoints", () => {
  const sys: Message = { role: "system", content: "standing rules" };

  it("marks the system prompt, which caches the tools with it", () => {
    const body = toAnthropicBody(req({ messages: [sys, { role: "user", content: "hi" }] }));
    // A bare string cannot carry a breakpoint, so the system prompt takes its one-block form.
    expect(body.system).toEqual([{ type: "text", text: "standing rules", cache_control: { type: "ephemeral" } }]);
  });

  /** No system prompt, nothing to mark — and no empty block invented to carry the marker. */
  it("leaves the system field absent when there is no system prompt", () => {
    expect(toAnthropicBody(req())).not.toHaveProperty("system");
  });

  /** The end of the conversation is the boundary the NEXT turn re-sends verbatim: write now, read next. */
  it("marks the last block of the last turn, and only that one", () => {
    const body = toAnthropicBody(req({ messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ] }));
    const turns = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(turns.at(-1)!.content.at(-1)).toHaveProperty("cache_control", { type: "ephemeral" });
    const earlier = turns.slice(0, -1).flatMap((t) => t.content);
    for (const b of earlier) expect(b).not.toHaveProperty("cache_control");
  });

  /** Two breakpoints, well under the limit of four — one for the fixed prefix, one for the moving edge. */
  it("spends exactly two of the four breakpoints", () => {
    const body = toAnthropicBody(req({ messages: [sys, { role: "user", content: "hi" }] }));
    const marks = JSON.stringify(body).match(/"cache_control"/g) ?? [];
    expect(marks).toHaveLength(2);
  });

  /** The caller's own messages must come back unchanged — the body is built from them, not over them. */
  it("does not mutate the request it was given", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const snapshot = JSON.stringify(messages);
    toAnthropicBody(req({ messages }));
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

/**
 * A cache read is billed at a fraction and a WRITE at a premium, so reporting only reads reads as pure
 * profit — the first turn of every agent, the one that fills the cache, would cost nothing on paper. The
 * true prompt spend is fresh + read + write, and only two of the three were being recorded.
 */
describe("usage accounting for the cache", () => {
  const start = (usage: Record<string, number>) =>
    ({ type: "message_start", message: { usage } });

  it("records what the cache cost as well as what it saved", () => {
    const d = new AnthropicDecoder();
    d.push(start({ input_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 12209 }));
    d.push({ type: "message_delta", usage: { output_tokens: 4 } });
    expect(d.usage()).toEqual({ promptTokens: 13, completionTokens: 4, cachedTokens: 0, cacheWriteTokens: 12209 });
  });

  it("reports a cache READ turn with nothing written", () => {
    const d = new AnthropicDecoder();
    d.push(start({ input_tokens: 13, cache_read_input_tokens: 12209, cache_creation_input_tokens: 0 }));
    d.push({ type: "message_delta", usage: { output_tokens: 4 } });
    expect(d.usage()).toMatchObject({ cachedTokens: 12209, cacheWriteTokens: 0 });
  });

  /** A response from before caching, or from a model that ignores it, must still account to zero — not NaN. */
  it("treats an absent cache field as zero", () => {
    const d = new AnthropicDecoder();
    d.push(start({ input_tokens: 900 }));
    expect(d.usage()).toMatchObject({ promptTokens: 900, cachedTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("which models speak Anthropic's schema", () => {
  it("recognises the Claude family, however the catalog namespaces it", () => {
    for (const m of ["cc/claude-opus-5", "no-think/cc/claude-sonnet-5", "antigravity/claude-sonnet-4-6",
      "cc/claude-fable-5", "cc/claude-haiku-4-5-20251001"]) {
      expect(isAnthropicModel(m), m).toBe(true);
    }
  });

  it("leaves every other family on the path it already worked on", () => {
    for (const m of ["cx/gpt-5.6-terra", "cx/gpt-5.5-xhigh", "tllm/gemini_3_pro", "codex/o3", "deepseek-v4"]) {
      expect(isAnthropicModel(m), m).toBe(false);
    }
  });
});

describe("the request body", () => {
  it("sends the effort level — the only reason this transport exists", () => {
    expect(toAnthropicBody(req({ effort: "xhigh" })).output_config).toEqual({ effort: "xhigh" });
  });

  it("sends no level at all when none was set, so the API's own default stands", () => {
    expect(toAnthropicBody(req())).not.toHaveProperty("output_config");
  });

  /**
   * `max_tokens` is required here and absent from the OpenAI body, so this transport must name a number the
   * other one never had to. Erring high costs nothing; erring low truncates a long file mid-write.
   */
  it("names an output ceiling, generously", () => {
    expect(toAnthropicBody(req()).max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(64_000);
  });

  it("streams, and asks for tools in Anthropic's shape", () => {
    const body = toAnthropicBody(req({
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
    }));
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([
      { name: "read_file", description: "Read a file", input_schema: { type: "object" } },
    ]);
  });

  it("only accepts the levels the API has", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"]) expect(isEffort(e)).toBe(true);
    for (const e of ["bogus", "", "HIGH", 3, undefined]) expect(isEffort(e)).toBe(false);
  });
});

describe("the conversation, in Anthropic's shape", () => {
  it("lifts the system prompt out of the messages, where it is a field of its own", () => {
    const { system, turns } = toAnthropicMessages([
      { role: "system", content: "You are a tester." },
      { role: "user", content: "go" },
    ]);
    expect(system).toBe("You are a tester.");
    expect(turns).toEqual([{ role: "user", content: [{ type: "text", text: "go" }] }]);
  });

  /**
   * A run of tool results arrives as one message each, and consecutive user turns are rejected — so they
   * have to become one turn carrying several blocks.
   */
  it("folds a run of tool results into a single user turn", () => {
    const { turns } = toAnthropicMessages([
      { role: "user", content: "read them" },
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "t2", name: "read_file", arguments: '{"path":"b.ts"}' },
      ] },
      { role: "tool", toolCallId: "t1", content: "A" },
      { role: "tool", toolCallId: "t2", content: "B" },
    ]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "A" },
      { type: "tool_result", tool_use_id: "t2", content: "B" },
    ]);
  });

  it("writes no empty text block for an assistant turn that only calls a tool", () => {
    const { turns } = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "glob", arguments: "{}" }] },
    ]);
    expect(turns[0]!.content).toEqual([{ type: "tool_use", id: "t1", name: "glob", input: {} }]);
  });

  it("parses a tool call's arguments into an object, and refuses to send anything else", () => {
    const { turns } = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "x", arguments: '{"k":1}' },
        { id: "b", name: "y", arguments: "not json" },
        { id: "c", name: "z", arguments: "[1,2]" },   // an array is not an input object either
      ] },
    ]);
    expect(turns[0]!.content).toEqual([
      { type: "tool_use", id: "a", name: "x", input: { k: 1 } },
      { type: "tool_use", id: "b", name: "y", input: {} },
      { type: "tool_use", id: "c", name: "z", input: {} },
    ]);
  });

  it("carries a pasted screenshot as an image block", () => {
    const { turns } = toAnthropicMessages([
      { role: "user", content: "what is this", images: ["data:image/png;base64,AAAA"] },
    ]);
    expect(turns[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this" },
    ]);
  });

  it("drops a string that is not a data URI rather than sending a broken block", () => {
    const { turns } = toAnthropicMessages([
      { role: "user", content: "look", images: ["https://example.com/x.png"] },
    ]);
    expect(turns[0]!.content).toEqual([{ type: "text", text: "look" }]);
  });

  it("says something for a tool that returned nothing — an empty block is rejected", () => {
    const { turns } = toAnthropicMessages([{ role: "tool", toolCallId: "t", content: "" } as Message]);
    expect(turns[0]!.content[0]).toMatchObject({ type: "tool_result", content: "(no output)" });
  });
});

describe("decoding Anthropic's event stream", () => {
  const ev = (d: AnthropicDecoder, o: unknown) => d.push(o);

  it("turns text deltas into text", () => {
    const d = new AnthropicDecoder();
    expect(ev(d, { type: "content_block_start", index: 0, content_block: { type: "text" } })).toEqual([]);
    expect(ev(d, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } }))
      .toEqual([{ type: "text-delta", text: "he" }]);
  });

  it("assembles a tool call and emits it when its block closes", () => {
    const d = new AnthropicDecoder();
    ev(d, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_file" } });
    ev(d, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } });
    ev(d, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } });
    expect(ev(d, { type: "content_block_stop", index: 0 })).toEqual([
      { type: "tool-call", toolCall: { id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  it("reports a long argument as live progress, with the file it is writing", () => {
    const d = new AnthropicDecoder();
    ev(d, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "write_file" } });
    const out = ev(d, { type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: `{"path":"src/app.ts","content":"${"x".repeat(200)}` } });
    expect(out[0]).toMatchObject({ type: "tool-progress", name: "write_file", path: "src/app.ts" });
  });

  /**
   * Thinking is content the model produced for itself. Emitted as text it would land in the answer the user
   * reads and in every later turn's re-sent transcript.
   */
  it("reads thinking and says nothing", () => {
    const d = new AnthropicDecoder();
    ev(d, { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
    expect(ev(d, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }))
      .toEqual([]);
  });

  it("takes usage from both ends of the stream", () => {
    const d = new AnthropicDecoder();
    ev(d, { type: "message_start", message: { usage: { input_tokens: 33, cache_read_input_tokens: 12 } } });
    ev(d, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } });
    // cacheWriteTokens joins the shape: what the cache cost, beside what it saved. See the usage suite above.
    expect(d.usage()).toEqual({ promptTokens: 33, completionTokens: 4, cachedTokens: 12, cacheWriteTokens: 0 });
    expect(d.finishReason()).toBe("tool_calls");
  });

  it("says nothing about usage the stream never reported", () => {
    expect(new AnthropicDecoder().usage()).toBeUndefined();
  });

  it("surfaces a mid-stream error as one, and lets a fallback try", () => {
    const d = new AnthropicDecoder();
    expect(ev(d, { type: "error", error: { message: "overloaded" } }))
      .toEqual([{ type: "error", message: "overloaded", retryable: true }]);
  });

  it("maps every stop reason to one this system knows", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("max_tokens")).toBe("length");
    for (const r of ["end_turn", "stop_sequence", "refusal", null, undefined]) {
      expect(mapStopReason(r)).toBe("stop");
    }
  });
});

/**
 * The level has to survive the whole way: config → role → agent options → request body.
 */
describe("where an effort level travels", () => {
  const src = (f: string): Promise<string> => readFile(f, "utf8");

  it("is read from the project's config rather than stripped on the way in", async () => {
    const s = await src("src/config/config.ts");
    expect(s).toContain('effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional()');
  });

  it("rides with the model chain, so the callers that take only the chain get it too", async () => {
    expect(await src("src/agent/roles.ts")).toContain("...(effort ? { effort } : {})");
  });

  it("reaches the request the provider sends", async () => {
    expect(await src("src/agent/loop.ts")).toContain("...(opts.effort ? { effort: opts.effort } : {})");
  });

  it("picks the schema by the model, not by a setting someone has to remember", async () => {
    const s = await src("src/providers/omniroute.ts");
    expect(s).toContain("const native = isAnthropicModel(req.model);");
    expect(s).toContain('`${this.baseUrl}${native ? "/v1/messages" : "/api/v1/chat/completions"}`');
    expect(s).toContain('headers["anthropic-version"] = "2023-06-01"');
  });
});
