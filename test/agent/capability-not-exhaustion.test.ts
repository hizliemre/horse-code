import { describe, it, expect } from "vitest";
import { isCapabilityError, isRetryableStatus } from "../../src/providers/omniroute.js";
import { runRoleAgent } from "../../src/agent/loop.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";

/**
 * "The long context beta is not yet available for this subscription" says this REQUEST does not fit this
 * model — not that the model is unwell. It was benched anyway, which took a perfectly usable model out of
 * the pool for every later request too, including all the ones small enough for it.
 *
 * Two different meanings had been loaded onto one flag: `retryable` said both "try the next model for this
 * request" and "this model is spent". The first is right here; the second is not.
 */
describe("a capability refusal is not exhaustion", () => {
  it.each([
    "[400]: The long context beta is not yet available for this subscription.",
    "context length exceeded",
    "maximum context is 200000 tokens",
    "this feature is not supported by the model",
  ])("recognises %o", (message) => {
    expect(isCapabilityError(message)).toBe(true);
  });

  it("does not mistake an ordinary failure for one", () => {
    expect(isCapabilityError("Internal server error")).toBe(false);
    expect(isCapabilityError("Unauthorized")).toBe(false);
  });

  /** A 400 is not retryable by status; it becomes retryable only because it is a capability refusal. */
  it("is retryable despite the status that carries it", () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  const opts = (p: MockProvider, extra: Record<string, unknown>) => ({
    provider: p,
    model: "m",
    fallbacks: ["f1"],
    systemPrompt: "s",
    tools: new ToolRegistry(),
    messages: [{ role: "user" as const, content: "hi" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...extra,
  });

  const drain = async (gen: AsyncIterable<unknown>): Promise<void> => { for await (const _ of gen) { /* run */ } };

  it("falls back to the next model without benching the one that refused", async () => {
    const p = new MockProvider([
      [{ type: "error", message: "long context beta is not available", retryable: true, capability: true }],
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const benched: string[] = [];
    const fellBack: string[] = [];
    await drain(runRoleAgent(opts(p, {
      onExhausted: (m: string) => benched.push(m),
      onFallback: (from: string) => fellBack.push(from),
    }) as never));
    expect(fellBack).toEqual(["m"]); // it did move on for THIS request
    expect(benched).toEqual([]); // …and the model stays in the pool for the next one
  });

  it("still benches a model that is genuinely spent", async () => {
    const p = new MockProvider([
      [{ type: "error", message: "429 rate limited", retryable: true }],
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const benched: string[] = [];
    await drain(runRoleAgent(opts(p, { onExhausted: (m: string) => benched.push(m) }) as never));
    expect(benched).toEqual(["m"]);
  });
});
