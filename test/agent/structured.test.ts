import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runStructuredRole } from "../../src/agent/structured.js";
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
    expect(p.requests).toHaveLength(3); // maxAttempts passes before giving up
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
