import { describe, it, expect } from "vitest";
import { cliArgs, decodeClaudeEvent, decodeCodexEvent, makeStreamReader } from "../../src/agents/cli-agent.js";
import type { CliEvent } from "../../src/agents/cli-agent.js";

/**
 * Every line here is real output from `claude -p --output-format stream-json --verbose`, captured from the
 * installed binary rather than written from memory — the shape is the whole contract of this module.
 */
const CLAUDE = {
  assistant: '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Ce","type":"message",'
    + '"role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":null,'
    + '"usage":{"input_tokens":2,"cache_creation_input_tokens":21446,"cache_read_input_tokens":10126,'
    + '"output_tokens":4,"service_tier":"standard"}}}',
  tool: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1",'
    + '"name":"Write","input":{"file_path":"src/a.ts","content":"x"}}]}}',
  result: '{"type":"result","subtype":"success","duration_api_ms":1896,"stop_reason":"end_turn",'
    + '"session_id":"d3b6cf44","total_cost_usd":0.219633,'
    + '"usage":{"input_tokens":2,"cache_creation_input_tokens":21446,"cache_read_input_tokens":10126,'
    + '"output_tokens":4}}',
  init: '{"type":"system","subtype":"init","session_id":"d3b6cf44"}',
  hook: '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
  // Real: a SUCCESSFUL call carries one of these too. Status is the field that matters, not the presence.
  quotaOk: '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788471000,'
    + '"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.27},'
    + '"seven_day":{"utilization":0.05}}}}',
  quotaRefused: '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788471000,'
    + '"unifiedWindows":{"five_hour":{"utilization":1},"seven_day":{"utilization":0.41}}}}',
};

describe("the headless argv for each CLI", () => {
  /** `--verbose` is not decoration: without it stream-json emits only the result, and every turn is lost. */
  it("asks Claude Code for the per-turn stream, not just the result", () => {
    const a = cliArgs("claude", "do the thing");
    expect(a).toEqual(["-p", "do the thing", "--output-format", "stream-json", "--verbose"]);
  });

  it("uses Codex's own non-interactive verb", () => {
    expect(cliArgs("codex", "do the thing")).toEqual(["exec", "--json", "do the thing"]);
  });

  it("passes the caller's extra arguments through, after the prompt", () => {
    expect(cliArgs("claude", "p", ["--add-dir", "/w"])).toContain("--add-dir");
  });
});

describe("decoding Claude Code's stream", () => {
  it("reads the assistant's prose", () => {
    expect(decodeClaudeEvent(CLAUDE.assistant)?.text).toBe("ok");
  });

  /** The CLI's agent runs its own tools; horse-code does not execute them, it only reports what happened. */
  it("reads a tool the CLI's own agent ran, and what it was about", () => {
    expect(decodeClaudeEvent(CLAUDE.tool)?.tool).toEqual({ name: "Write", target: "src/a.ts" });
  });

  /**
   * The three cache figures are the reason delegation is measurable at all: the same accounting the API path
   * reports, so a run on either transport can be compared against the other.
   */
  it("reads the full usage, cache writes included", () => {
    expect(decodeClaudeEvent(CLAUDE.result)?.usage).toEqual({
      freshTokens: 2, cachedTokens: 10126, cacheWriteTokens: 21446, outputTokens: 4, costUsd: 0.219633,
    });
  });

  /**
   * `rate_limit_event` is quota TELEMETRY, not a failure — and reading it as one aborts every call.
   *
   * Caught live: the first structured role sent through this provider came back refused for no reason,
   * because a successful call carries this event too, with `status: "allowed"` and the utilization of each
   * window. Only a non-allowed status is a refusal.
   */
  it("reads an allowed quota report as telemetry, not as a refusal", () => {
    const ev = decodeClaudeEvent(CLAUDE.quotaOk);
    expect(ev?.rateLimited).toBeUndefined();
    expect(ev?.quota).toEqual({
      status: "allowed", resetsAt: 1788471000, windows: { five_hour: 0.27, seven_day: 0.05 },
    });
  });

  /**
   * …and a refusal IS the signal the bench/park machinery is built around, carrying the numbers a person
   * can act on rather than a bare "rate limited".
   */
  it("surfaces a refusal as a rate limit, with the windows spelled out", () => {
    const ev = decodeClaudeEvent(CLAUDE.quotaRefused);
    expect(ev?.rateLimited).toBe("rejected — five_hour 100%, seven_day 41%");
    expect(ev?.quota?.status).toBe("rejected");
  });

  /** The stream is mostly hooks and framing — anything without meaning here must decode to nothing. */
  it("ignores the framing", () => {
    expect(decodeClaudeEvent(CLAUDE.init)).toBeUndefined();
    expect(decodeClaudeEvent(CLAUDE.hook)).toBeUndefined();
    expect(decodeClaudeEvent("not json at all")).toBeUndefined();
  });
});

describe("decoding Codex's stream", () => {
  it("reads a completed message and a usage turn", () => {
    expect(decodeCodexEvent('{"type":"item.completed","text":"done"}')?.text).toBe("done");
    expect(decodeCodexEvent('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}')?.usage)
      .toEqual({ freshTokens: 10, cachedTokens: 4, cacheWriteTokens: 0, outputTokens: 2 });
  });

  it("surfaces its rate limit too", () => {
    expect(decodeCodexEvent('{"type":"rate_limit","message":"slow down"}')?.rateLimited).toBe("slow down");
  });
});

/**
 * The stream arrives in chunks that do not respect line boundaries — a JSON event routinely spans two reads.
 * A reader that forgets the half-line drops whichever event straddled the split, and for the `result` line
 * that is the entire usage accounting for the run.
 */
describe("reading a chunked stream", () => {
  const collect = (chunks: string[]) => {
    const seen: CliEvent[] = [];
    const r = makeStreamReader(decodeClaudeEvent, (ev) => seen.push(ev));
    for (const c of chunks) r.push(c);
    r.end();
    return seen;
  };

  it("decodes events that arrive whole", () => {
    const seen = collect([`${CLAUDE.assistant}\n${CLAUDE.result}\n`]);
    expect(seen.map((e) => e.text ?? "usage")).toEqual(["ok", "usage"]);
  });

  /** The case that matters: the result line — and with it all the usage — split across two reads. */
  it("holds a half-line between reads instead of dropping it", () => {
    const half = Math.floor(CLAUDE.result.length / 2);
    const seen = collect([
      `${CLAUDE.assistant}\n${CLAUDE.result.slice(0, half)}`,
      `${CLAUDE.result.slice(half)}\n`,
    ]);
    expect(seen.find((e) => e.usage)?.usage?.cacheWriteTokens).toBe(21446);
  });

  /** A stream that ends without a trailing newline must still yield its last event. */
  it("decodes a final line with no newline after it", () => {
    const seen = collect([CLAUDE.result]);
    expect(seen.find((e) => e.usage)?.usage?.outputTokens).toBe(4);
  });

  it("survives interleaved framing and junk", () => {
    const seen = collect([`${CLAUDE.hook}\n`, "\n", "not json\n", `${CLAUDE.quotaRefused}\n`]);
    expect(seen).toHaveLength(1);
    expect(seen[0].rateLimited).toMatch(/rejected/);
  });
});
