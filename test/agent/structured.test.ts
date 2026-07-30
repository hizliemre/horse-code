import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runStructuredRole } from "../../src/agent/structured.js";
import type { Provider } from "../../src/core/types.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent, Tool } from "../../src/core/types.js";

const schema = z.object({ decision: z.enum(["pass", "fail"]) });

function opts(provider: MockProvider): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "you are a reviewer",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: "review this" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };
}

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("runStructuredRole", () => {
  it("parses and returns a valid submit; submit tool is present in the request", async () => {
    const p = new MockProvider([submitTurn('{"decision":"pass"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "pass" });
    expect(p.requests[0].tools.map((t) => t.name)).toContain("submit");
    expect(p.requests).toHaveLength(1); // valid submit → early exit, no extra turn
  });

  it("invalid submit followed by a valid submit → correct result (2 requests)", async () => {
    const p = new MockProvider([submitTurn('{"decision":"bogus"}'), submitTurn('{"decision":"fail"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "fail" });
    expect(p.requests).toHaveLength(2);
  });

  it("prose (no submit) → nudged to retry, then a valid submit succeeds (2 requests)", async () => {
    const prose: ChatEvent[] = [{ type: "text-delta", text: "I think it passes." }, { type: "done", finishReason: "stop" }];
    const p = new MockProvider([prose, submitTurn('{"decision":"pass"}')]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "pass" });
    expect(p.requests).toHaveLength(2); // first prose pass + one nudged retry
    // the nudge is appended as a user turn before the retry
    expect(JSON.stringify(p.requests[1].messages)).toContain("did not call the `submit` tool");
  });

  it("salvages JSON emitted in prose when the model never calls submit (1 request)", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: '{"decision":"fail"}' }, { type: "done", finishReason: "stop" }]]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "fail" });
    expect(p.requests).toHaveLength(1); // salvaged without a retry
  });

  it("salvages a JSON block wrapped in surrounding prose", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: 'Here you go: {"decision":"pass"} — done.' }, { type: "done", finishReason: "stop" }]]);
    const out = await runStructuredRole(opts(p), schema);
    expect(out).toEqual({ decision: "pass" });
  });

  it("throws if submit is never called and nothing can be salvaged (after retries)", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow(/submit was not called/);
    // Two nudges per model, not three: a model that ignored `submit` twice almost never converts on a third
    // pass, and each extra pass re-sends the whole (by then large) conversation.
    expect(p.requests).toHaveLength(2);
  });

  it("primary answers only in prose → falls to the FALLBACK model, which submits → success", async () => {
    const prose: ChatEvent[] = [{ type: "text-delta", text: "no opinion" }, { type: "done", finishReason: "stop" }];
    // primary "m" refuses to submit for all 3 attempts (prose), then fallback "f1" submits.
    const p = new MockProvider([prose, prose, prose, submitTurn('{"decision":"pass"}')]);
    const out = await runStructuredRole({ ...opts(p), fallbacks: ["f1"] }, schema);
    expect(out).toEqual({ decision: "pass" });
    expect(p.requests).toHaveLength(4);
    expect(p.requests[0].model).toBe("m");  // primary tried (3 prose attempts)
    expect(p.requests[3].model).toBe("f1"); // then the fallback model, which submitted
  });

  it("primary errors → falls to the FALLBACK model, which submits", async () => {
    const p = new MockProvider([[{ type: "error", message: "404 not found", retryable: true }], submitTurn('{"decision":"fail"}')]);
    const out = await runStructuredRole({ ...opts(p), fallbacks: ["f1"] }, schema);
    expect(out).toEqual({ decision: "fail" });
    expect(p.requests[1].model).toBe("f1"); // fell to the fallback after the primary errored
  });

  it("whole chain fails → throws the last hard error (not a generic message)", async () => {
    const p = new MockProvider([
      [{ type: "error", message: "primary 404" }],
      [{ type: "error", message: "fallback 500" }],
    ]);
    await expect(runStructuredRole({ ...opts(p), fallbacks: ["f1"] }, schema)).rejects.toThrow("fallback 500");
  });

  it("throws on provider error", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runStructuredRole(opts(p), schema)).rejects.toThrow("boom");
  });

  it("previously aborted signal → throws a cancellation error (not the misleading 'submit was not called')", async () => {
    const p = new MockProvider([submitTurn('{"decision":"pass"}')]);
    const ac = new AbortController();
    ac.abort();
    const o = { ...opts(p), signal: ac.signal };
    await expect(runStructuredRole(o, schema)).rejects.toThrow(/cancel/);
  });

  it("the role's own tools are preserved; submit is added in addition", async () => {
    const noop: Tool = {
      name: "noop",
      description: "does nothing",
      permissionLevel: "safe",
      parameters: z.object({}),
      run: async () => ({ content: "ok", isError: false }),
    };
    const registry = new ToolRegistry();
    registry.register(noop);
    const p = new MockProvider([submitTurn('{"decision":"pass"}')]);
    const o = { ...opts(p), tools: registry };
    const out = await runStructuredRole(o, schema);
    expect(out).toEqual({ decision: "pass" });
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toContain("noop");
    expect(names).toContain("submit");
  });
});

// Running out of tool budget is not a model defect — the conversation already holds everything the role read.
// Treating it as a hard error made a 15-turn cap WORSE than none: it discarded the work and repeated it on
// every fallback model.
describe("runStructuredRole — a spent turn budget is not a model failure", () => {
  it("asks the same model to submit what it has instead of falling to the next one", async () => {
    // Pass 1: burns its 1-turn budget on a tool call → "maximum turn count exceeded".
    // Pass 2 (the nudge): submits.
    const loop: ChatEvent[] = [
      { type: "tool-call", toolCall: { id: "t", name: "noop", arguments: "{}" } },
      { type: "done", finishReason: "tool_calls" },
    ];
    const submit: ChatEvent[] = [
      { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"decision":"pass"}' } },
      { type: "done", finishReason: "tool_calls" },
    ];
    const p = new MockProvider([loop, submit]);
    const o = { ...opts(p), maxTurns: 1, fallbacks: ["f1"] };
    expect(await runStructuredRole(o, schema)).toEqual({ decision: "pass" });
    // The second request went to the SAME model — the fallback was never touched.
    expect(p.requests.map((r) => r.model)).toEqual(["m", "m"]);
    expect(p.requests[1].messages.some((m) => typeof m.content === "string" && /entire tool-call budget/i.test(m.content))).toBe(true);
  });
});

/**
 * One deadline for the whole call is worse than none.
 *
 * Measured live: `antigravity/gemini-2.5-pro` hung on a commit-message call, was cut at exactly 180.0s — the
 * whole budget — and every fallback then saw an already-aborted signal and could not run. The task landed
 * with `chore: <title>` instead of a written message, and the `retryable` flag on the timeout was meaningless
 * because nothing was left to retry with.
 */
describe("each model in the chain gets its own deadline", () => {
  /**
   * The first model never answers; the second does. Mirrors what the real provider does when a deadline
   * fires: an error EVENT that is retryable, not a thrown exception (see omniroute's isDeadline).
   */
  const hangThenAnswer = (): Provider => {
    let call = 0;
    return {
      async *chat(_req, signal) {
        call += 1;
        if (call === 1) {
          await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
          yield { type: "error", message: "the model did not answer within its deadline", retryable: true };
          return;
        }
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"message":"feat: real"}' } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
  };

  it("falls through to the next model after the first one's clock runs out", async () => {
    const out = await runStructuredRole({
      ...opts(new MockProvider([])), provider: hangThenAnswer(),
      model: "slow/one", fallbacks: ["fast/two"],
      perAttemptMs: 40,
    }, z.object({ message: z.string() }));
    expect(out.message).toBe("feat: real");
  }, 10_000);

  /** Without a per-attempt clock the old behaviour stands: the caller's signal is the only one. */
  it("uses the caller's signal alone when no per-attempt deadline is given", async () => {
    const p = runStructuredRole({
      ...opts(new MockProvider([])), provider: hangThenAnswer(),
      model: "slow/one", fallbacks: ["fast/two"],
    }, z.object({ message: z.string() })).catch(() => "threw");
    // Nothing bounds the first model, so the call is still waiting when the race resolves.
    await expect(Promise.race([p, new Promise((r) => setTimeout(() => r("still-waiting"), 200))]))
      .resolves.toBe("still-waiting");
  }, 10_000);
});

/**
 * The per-attempt clock was useless the moment it was added, and it took a live run to see why.
 *
 * `runRoleAgent` reported ANY aborted signal as "cancelled — not retryable", and since each model attempt is
 * now given its own clock, the first slow model ended the whole chain walk. The log showed it exactly: six
 * models reporting a deadline in the same second, again and again, and not one review finishing in four
 * hours. A deadline of ours is a statement about ONE model; a cancellation is a statement about the run.
 */
describe("a per-attempt deadline is not a cancellation", () => {
  /**
   * A provider whose request dies when the signal fires, reporting it as a transport fault — which is what an
   * aborted fetch looks like from below. Classifying it is the loop's job, and the point of this test.
   */
  const hang = (): Provider => ({
    async *chat(_req, signal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      yield { type: "error", message: "fetch failed", retryable: true };
    },
  });

  it("reports the deadline, not 'cancelled', when our own clock fires", async () => {
    await expect(runStructuredRole({
      ...opts(new MockProvider([])), provider: hang(), model: "slow/one", perAttemptMs: 30,
    }, z.object({ a: z.string() }))).rejects.toThrow(/deadline/i);
  }, 10_000);

  /** And a real cancellation still ends everything — trying another model would be ignoring the person. */
  it("still says cancelled when the caller aborts", async () => {
    const ac = new AbortController();
    const p = runStructuredRole({
      ...opts(new MockProvider([])), provider: hang(), model: "slow/one", fallbacks: ["f"],
      signal: ac.signal, perAttemptMs: 60_000,
    }, z.object({ a: z.string() }));
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/cancelled/i);
  }, 10_000);
});

/**
 * Per-model clocks fixed one bug and created another.
 *
 * With three models and two attempts each, a three-minute deadline means eighteen minutes before the chain
 * gives up. Measured live: a task sat at DONE for a quarter of an hour while its one-sentence commit message
 * walked the chain — nothing hung, no git process, nothing in the log to see. Both bounds are needed.
 */
describe("the whole chain has a ceiling too", () => {
  const alwaysSlow = (): Provider => ({
    async *chat(_req, signal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      yield { type: "error", message: "fetch failed", retryable: true };
    },
  });

  it("stops walking once the total budget is gone", async () => {
    const started = Date.now();
    await expect(runStructuredRole({
      ...opts(new MockProvider([])), provider: alwaysSlow(),
      model: "a", fallbacks: ["b", "c", "d"],
      perAttemptMs: 40, totalMs: 120,
    }, z.object({ a: z.string() }))).rejects.toThrow(/total budget/i);
    // Four models × two attempts × 40ms would be 320ms; the total cuts it well short of that.
    expect(Date.now() - started).toBeLessThan(300);
  }, 10_000);

  /** Without a total, the chain still walks every model — the per-attempt clock is the only bound. */
  it("walks the whole chain when no total is given", async () => {
    await expect(runStructuredRole({
      ...opts(new MockProvider([])), provider: alwaysSlow(),
      model: "a", fallbacks: ["b"], perAttemptMs: 20,
    }, z.object({ a: z.string() }))).rejects.toThrow();
  }, 10_000);

  /** A chain that answers in time is untouched by either bound. */
  it("does not interfere with a model that answers", async () => {
    const out = await runStructuredRole({
      ...opts(new MockProvider([submitTurn('{"a":"ok"}')])),
      perAttemptMs: 5_000, totalMs: 10_000,
    }, z.object({ a: z.string() }));
    expect(out.a).toBe("ok");
  });
});
