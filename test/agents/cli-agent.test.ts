import { describe, it, expect } from "vitest";
import {
  cliArgs, decodeClaudeEvent, decodeCodexEvent, makeStreamReader, reportedError,
  CLI_ERROR_UNSPOKEN, CLI_KINDS, SYNTHETIC,
} from "../../src/agents/cli-agent.js";
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
    expect(cliArgs("claude", "do the thing"))
      .toEqual(["--output-format", "stream-json", "--verbose", "-p", "--", "do the thing"]);
  });

  /** Codex refuses outright outside a trusted directory — "Not inside a trusted directory", measured. */
  it("uses Codex's own non-interactive verb and does not trip its repo check", () => {
    expect(cliArgs("codex", "do the thing"))
      .toEqual(["exec", "--json", "--skip-git-repo-check", "--", "do the thing"]);
  });

  it("passes the caller's extra arguments through, ahead of the prompt", () => {
    const a = cliArgs("claude", "p", ["--add-dir", "/w"]);
    expect(a).toContain("--add-dir");
    expect(a.indexOf("--add-dir")).toBeLessThan(a.indexOf("--"));
  });

  /**
   * A prompt is TEXT, and text can start with a dash. Both CLIs parsed a leading `-` as an option and
   * refused the call before a model was reached — `error: unknown option '---` from Claude, `error:
   * unexpected argument '---` from Codex, each measured against the real binary.
   *
   * Not a corner case: every spec-kit command document opens with YAML front matter, so `---` is the first
   * thing on the line and delegating ANY spec-kit phase failed outright.
   */
  it("survives a prompt that begins with a dash", () => {
    for (const kind of ["claude", "codex"] as const) {
      const a = cliArgs(kind, "---\ntitle: x\n---\ndo the thing");
      expect(a.at(-1)).toBe("---\ntitle: x\n---\ndo the thing");
      expect(a.at(-2)).toBe("--");
    }
  });

  /** The Anthropic Messages wire format, which is why one decoder reads both this and Claude's stream. */
  it("asks Grok for the stream Claude's decoder already understands", () => {
    expect(cliArgs("grok", "do the thing"))
      .toEqual(["--output-format", "streaming-messages-json", "--single=do the thing"]);
  });

  /**
   * Grok needs the OPPOSITE of what the other two need, and a `--` makes it worse rather than better.
   *
   * Its prompt is a flag's VALUE (`-p/--single <PROMPT>`), not a positional argument, so clap rejects a
   * value beginning with a dash before the prompt is read — and a `--` ends option parsing before the flag
   * has taken one. Both measured against the binary, on the same front-matter prompt:
   *
   *   grok -p "---…"     → error: a value is required for '--single <PROMPT>' but none was supplied
   *   grok -p -- "---…"  → error: a value is required for '--single <PROMPT>' but none was supplied
   *
   * Attached with `=`, the text is never parsed as an option at all.
   */
  it("attaches Grok's prompt to its flag, because a separator cannot save it", () => {
    const a = cliArgs("grok", "---\ntitle: x\n---\ndo the thing");
    expect(a.at(-1)).toBe("--single=---\ntitle: x\n---\ndo the thing");
    expect(a).not.toContain("--");
  });

  it("passes Grok the caller's extra arguments ahead of the prompt", () => {
    const a = cliArgs("grok", "p", ["--permission-mode", "acceptEdits"]);
    expect(a.indexOf("--permission-mode")).toBeLessThan(a.length - 1);
    expect(a.at(-1)).toBe("--single=p");
  });

  /**
   * Every CLI carries the prompt, in whichever shape it takes one. A kind added to the type without a branch
   * here would fall through to whichever branch happens to be last and be run as another binary's argv.
   */
  it("carries the prompt for every CLI it knows", () => {
    for (const kind of CLI_KINDS) {
      expect(cliArgs(kind, "carry me").some((a) => a.includes("carry me")), kind).toBe(true);
    }
  });
});

/**
 * Real output from `grok --single=… --output-format streaming-messages-json`, captured from the installed
 * binary. Trimmed only where a value is long and says nothing — the thinking block's `signature`, the tool
 * list on `init` — never reshaped.
 */
const GROK = {
  init: '{"type":"system","subtype":"init","session_id":"01a08111","apiKeySource":"oauth",'
    + '"model":"grok-4.6","cwd":"/w","permissionMode":"default","tools":["read_file","write"]}',
  // A thinking block sits BEFORE the text, and its `thinking` field must not be mistaken for the answer.
  assistant: '{"type":"assistant","message":{"id":"msg_0","type":"message","role":"assistant",'
    + '"model":"grok-4.6","content":[{"type":"thinking","thinking":"The user wants me to say exactly ok.",'
    + '"signature":"K5I8Dxo69YTCfDYVpKjjVco7"},{"type":"text","text":"ok"}],"stop_reason":"end_turn",'
    + '"usage":{"input_tokens":32377,"output_tokens":34}}}',
  tool: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use",'
    + '"id":"call-37b2a13a-0","name":"list_dir","input":{"target_directory":"."}}]}}',
  result: '{"type":"result","subtype":"success","is_error":false,"duration_ms":4527,"num_turns":1,'
    + '"result":"ok","stop_reason":"end_turn","total_cost_usd":0.01104286,'
    + '"usage":{"input_tokens":32377,"output_tokens":34,"cache_read_input_tokens":0,'
    + '"cache_creation_input_tokens":0},"session_id":"01a0811b"}',
};

/**
 * Grok's stream is Claude's, so the contract worth testing is that ONE decoder reads both — a second
 * decoder would be a copy that drifts.
 */
describe("decoding Grok's stream with Claude's decoder", () => {
  it("reads the assistant's prose, and not its thinking", () => {
    const ev = decodeClaudeEvent(GROK.assistant);
    expect(ev?.text).toBe("ok");
    expect(ev?.served).toBe("grok-4.6");
  });

  it("reads a tool its own agent ran", () => {
    expect(decodeClaudeEvent(GROK.tool)?.tool).toEqual({ name: "list_dir" });
  });

  it("reads the usage and the cost", () => {
    expect(decodeClaudeEvent(GROK.result)?.usage).toEqual({
      freshTokens: 32377, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 34, costUsd: 0.01104286,
    });
  });

  it("ignores the framing", () => {
    expect(decodeClaudeEvent(GROK.init)).toBeUndefined();
  });

  /**
   * Grok reports what a call COST and never how much of a window is left — there is no `rate_limit_event`
   * anywhere in its stream. So the pool learns nothing from a Grok call, and a start-up line can only ever
   * report the account, not its remaining quota. Stated here so the absence is a known fact rather than a
   * decoder that quietly stopped working.
   */
  it("carries no quota reading, because Grok reports none", () => {
    for (const line of Object.values(GROK)) expect(decodeClaudeEvent(line)?.quota).toBeUndefined();
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
    expect(ev?.rateLimited).toContain("rejected — five_hour 100%, seven_day 41%");
    expect(ev?.quota?.status).toBe("rejected");
  });

  /**
   * The reset instant rides along, because a spent window REOPENS. Without it the only safe bench is the
   * rest of the run, which on a ten-hour board writes off a subscription for hours after it recovered.
   */
  it("says when the spent window reopens, when the CLI says so", () => {
    const ev = decodeClaudeEvent(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: Math.floor(Date.parse("2026-09-04T05:30:00.000Z") / 1000),
        unifiedWindows: { five_hour: { utilization: 1 } },
      },
    }));
    expect(ev?.rateLimited).toContain("(resets 2026-09-04T05:30:00.000Z)");
  });

  /** The stream is mostly hooks and framing — anything without meaning here must decode to nothing. */
  it("ignores the framing", () => {
    expect(decodeClaudeEvent(CLAUDE.init)).toBeUndefined();
    expect(decodeClaudeEvent(CLAUDE.hook)).toBeUndefined();
    expect(decodeClaudeEvent("not json at all")).toBeUndefined();
  });
});

/**
 * Every line here is real output from `codex exec --json`, and two guesses about this shape were wrong
 * before it was captured. The text is nested under `item`, not at the top level — reading `e.text` returns
 * nothing and every Codex turn comes back silent. And Codex DOES report cache writes, which an earlier
 * comment denied; believing that would have made every Codex run look free beside a Claude one.
 */
describe("decoding Codex's stream", () => {
  const CODEX = {
    message: '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
    usage: '{"type":"turn.completed","usage":{"input_tokens":15448,"cached_input_tokens":11136,'
      + '"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    started: '{"type":"thread.started","thread_id":"01a068bb"}',
    turn: '{"type":"turn.started"}',
  };

  it("reads the message from where it actually is", () => {
    expect(decodeCodexEvent(CODEX.message)?.text).toBe("ok");
  });

  it("reads the full usage, cache writes included", () => {
    expect(decodeCodexEvent(CODEX.usage)?.usage).toEqual({
      freshTokens: 15448, cachedTokens: 11136, cacheWriteTokens: 0, outputTokens: 5,
    });
  });

  it("ignores its framing", () => {
    expect(decodeCodexEvent(CODEX.started)).toBeUndefined();
    expect(decodeCodexEvent(CODEX.turn)).toBeUndefined();
  });

  it("surfaces a failure and a rate limit", () => {
    expect(decodeCodexEvent('{"type":"turn.failed","message":"boom"}')?.error).toBe("boom");
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

/**
 * Which account of a failure reaches the caller.
 *
 * A `result` event can say `error_during_execution` and carry no text whatsoever, and then the only account
 * of what went wrong is on stderr. Measured on a signed-out Grok: the stream said that much and no more,
 * while stderr held the whole remedy — "Not signed in. To authenticate without a browser, run: grok login
 * --device-code". Preferring the stream unconditionally turns the one failure a person can fix into a
 * generic CLI fault.
 */
describe("choosing which failure to report", () => {
  const SIGNED_OUT = "Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code";

  it("prefers what the stream named", () => {
    expect(reportedError("model overloaded", "some noise", 1)).toBe("model overloaded");
  });

  it("falls to stderr when the stream only said that something failed", () => {
    expect(reportedError(CLI_ERROR_UNSPOKEN, SIGNED_OUT, 1)).toBe(SIGNED_OUT);
  });

  /** A CLI that warns on stderr and SUCCEEDS must not be read as having failed. */
  it("ignores stderr on a run that exited cleanly", () => {
    expect(reportedError(undefined, "warning: deprecated flag", 0)).toBeUndefined();
  });

  /** Still reported, even when neither side had anything specific — a known failure must not vanish. */
  it("keeps the bare report when stderr had nothing to add", () => {
    expect(reportedError(CLI_ERROR_UNSPOKEN, "", 1)).toBe(CLI_ERROR_UNSPOKEN);
  });
});

/**
 * Claude Code does not validate `--model`.
 *
 * Measured: `--model definitely-not-a-model` exits 0 with `subtype: "success"` and a plausible answer, while
 * `message.model` reads `<synthetic>` — no model ran and the text was produced locally. Nothing else in the
 * stream says so. Unchecked, a typo in one chain link becomes an invented answer recorded as that model's
 * work: the fitness store learns from it, the review counts it, a role is judged on a turn that never
 * happened.
 *
 * The same field is what shows an alias resolving — `opus` served `claude-opus-5`, `claude-haiku-4-5` served
 * `claude-haiku-4-5-20251001` — so reading it is worth doing for its own sake.
 */
describe("which model actually served the turn", () => {
  const served = (model: string) =>
    decodeClaudeEvent(`{"type":"assistant","message":{"model":"${model}",` +
      `"role":"assistant","content":[{"type":"text","text":"ok"}]}}`)?.served;

  it("reports the model the CLI resolved to, not the one asked for", () => {
    expect(served("claude-opus-5")).toBe("claude-opus-5");
    expect(served("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("surfaces the placeholder that means no model ran", () => {
    expect(served("<synthetic>")).toBe(SYNTHETIC);
  });
});

/**
 * A tool the CLI asked for and a tool that worked are different claims.
 *
 * `tool_use` is the model requesting; the outcome arrives later as a user turn carrying `tool_result`.
 * Measured: a write refused with "Claude requested permissions to edit … which is a sensitive file"
 * appeared on the row as `Write hello.txt` while no file was created. The row said the work was done.
 */
describe("the outcome of a tool the CLI ran", () => {
  const failed = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1",'
    + '"is_error":true,"content":"Claude requested permissions to edit /x/hello.txt which is a sensitive file."}]}}';
  const ok = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}';

  it("reports a failed call as failed", () => {
    expect(decodeClaudeEvent(failed)?.tool).toEqual({ name: "tool", ok: false });
  });

  /** A success was already announced when it was requested; saying it twice would double every row. */
  it("says nothing for a call that worked", () => {
    expect(decodeClaudeEvent(ok)).toBeUndefined();
  });
});

/**
 * A quota WARNING is not a refusal, and reading it as one throws away work that was already done.
 *
 * Measured on a live board: near its limit the CLI began reporting `allowed_warning` — the call was served —
 * and each was read as a rate limit, so a finished answer was discarded and the chain spent another call
 * getting it again, at 91% and 93% of the five-hour window. Nine calls, at exactly the moment when spending
 * them twice is worst.
 */
describe("a quota warning on a call that was served", () => {
  const evt = (status: string): string => JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status, unifiedWindows: { five_hour: { utilization: 0.91 }, seven_day: { utilization: 0.2 } } },
  });

  it("does not call a warning a rate limit", () => {
    const out = decodeClaudeEvent(evt("allowed_warning"));
    expect(out?.rateLimited).toBeUndefined();
    expect(out?.quota?.status).toBe("allowed_warning");
    // The reading itself still has to land, since this is the case where it matters most.
    expect(out?.quota?.windows).toEqual({ five_hour: 0.91, seven_day: 0.2 });
  });

  it("still reads a plain allow as served", () => {
    expect(decodeClaudeEvent(evt("allowed"))?.rateLimited).toBeUndefined();
  });

  /** A refusal is still a refusal — the bench depends on it. */
  it("still reads a refusal as a rate limit", () => {
    const out = decodeClaudeEvent(evt("rejected"));
    expect(out?.rateLimited).toContain("rejected");
    expect(out?.rateLimited).toContain("five_hour 91%");
  });
});

/**
 * A watched row has to say WHICH file changed, and Codex puts that in `changes`, not in a `path` field.
 *
 * Captured from the binary: `{"type":"file_change","changes":[{"path":"…/hello.txt","kind":"add"}]}`. Read as
 * a bare type name it lost the only detail worth showing, so every write on a live board said merely that
 * something had been written.
 */
describe("what Codex says it changed", () => {
  const ev = (item: unknown): string => JSON.stringify({ type: "item.completed", item });

  it("names the file from the change list", () => {
    const out = decodeCodexEvent(ev({ id: "i1", type: "file_change", changes: [{ path: "/w/hello.txt", kind: "add" }] }));
    expect(out?.tool).toEqual({ name: "file_change", target: "/w/hello.txt" });
  });

  it("counts the rest when a turn changed several", () => {
    const out = decodeCodexEvent(ev({
      type: "file_change",
      changes: [{ path: "/w/a.ts", kind: "add" }, { path: "/w/b.ts", kind: "edit" }, { path: "/w/c.ts", kind: "add" }],
    }));
    expect(out?.tool?.target).toBe("/w/a.ts +2");
  });

  it("still reports a tool that named no file", () => {
    expect(decodeCodexEvent(ev({ type: "command_execution" }))?.tool).toEqual({ name: "command_execution" });
  });
});
