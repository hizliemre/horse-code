import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runRoleAgent, runToCompletion, type RoleAgentOptions } from "../../src/agent/loop.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, ChatEvent, Tool } from "../../src/core/types.js";

const safeEcho: Tool = {
  name: "echo",
  description: "returns",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function opts(provider: MockProvider, over: Partial<RoleAgentOptions> = {}): RoleAgentOptions {
  return {
    provider,
    model: "m",
    systemPrompt: "you are a test role",
    tools: registry(safeEcho),
    messages: [{ role: "user", content: "hello" }],
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...over,
  };
}

describe("runRoleAgent", () => {
  it("single turn: emits text-delta, ends with message.done", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hel" }, { type: "text-delta", text: "lo" }, { type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([
      { type: "message.delta", text: "hel" },
      { type: "message.delta", text: "lo" },
      { type: "message.done", message: { role: "assistant", content: "hello" } },
    ]);
  });

  it("systemPrompt and user message go into the first request", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await drain(runRoleAgent(opts(p)));
    expect(p.requests[0].messages).toEqual([
      { role: "system", content: "you are a test role" },
      { role: "user", content: "hello" },
    ]);
  });

  it("tool-call turn: tool runs, result is appended to the second request, then it ends", async () => {
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }],
    ]);
    const events = await drain(runRoleAgent(opts(p)));
    // tool.request + tool.result were emitted
    expect(events.some((e) => e.type === "tool.request")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    // the second request has the tool result message
    const secondMsgs = p.requests[1].messages;
    expect(secondMsgs).toContainEqual({ role: "tool", toolCallId: "c1", name: "echo", content: "echo:x" });
    // final event is the final assistant message
    expect(events.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "done" } });
  });

  it("provider error → emits error event and ends", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    const events = await drain(runRoleAgent(opts(p)));
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("when maxTurns is exceeded, emits error event and stops", async () => {
    const toolCallTurn: ChatEvent[] = [
      { type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } },
      { type: "done", finishReason: "tool_calls" },
    ];
    const p = new MockProvider([toolCallTurn, toolCallTurn, toolCallTurn, toolCallTurn, toolCallTurn]);
    const events = await drain(runRoleAgent(opts(p, { maxTurns: 3 })));
    expect(events.some((e) => e.type === "error" && e.message.includes("maximum turn"))).toBe(true);
    expect(p.requests.length).toBe(3);
  });

  it("inbox: a by-the-way note is folded in as a user message on a later turn", async () => {
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "echo", arguments: '{"t":"x"}' } }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const notes: (string | undefined)[] = [undefined, "also check the tests"]; // nothing on turn 1, a note before turn 2
    let i = 0;
    const inbox = (): string | undefined => notes[i++];
    await drain(runRoleAgent(opts(p, { inbox })));
    expect(p.requests[0].messages).not.toContainEqual({ role: "user", content: "also check the tests" });
    expect(p.requests[1].messages).toContainEqual({ role: "user", content: "also check the tests" });
  });

  it("previously aborted signal: emits abort event, provider is never called", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    const events = await drain(runRoleAgent(opts(p, { signal: ac.signal })));
    expect(events).toEqual([{ type: "abort" }]);
    expect(p.requests.length).toBe(0);
  });
});

describe("runToCompletion", () => {
  it("returns the last assistant message", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "answer" }, { type: "done", finishReason: "stop" }]]);
    const msg = await runToCompletion(opts(p));
    expect(msg).toEqual({ role: "assistant", content: "answer" });
  });

  it("throws on error", async () => {
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    await expect(runToCompletion(opts(p))).rejects.toThrow("boom");
  });

  it("throws on a previously aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    await expect(runToCompletion(opts(p, { signal: ac.signal }))).rejects.toThrow(/cancel/);
  });
});

describe("runRoleAgent live activity", () => {
  it("forwards tool-progress as a 'writing <file> · N chars' label", async () => {
    const p = new MockProvider([[
      { type: "tool-progress", name: "write_file", chars: 1394, path: "specs/x/constitution.md" },
      { type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" },
    ]]);
    const labels: string[] = [];
    await drain(runRoleAgent(opts(p, { onLiveActivity: (l) => labels.push(l) })));
    expect(labels).toContain("writing constitution.md · 1.4k chars"); // basename + humanized size
  });

  /**
   * A tool with no file to write gets no live label at all.
   *
   * Its argument is generated in milliseconds, so the label only ever flashed — and because the row it
   * occupies resizes the status box, every flash made the progress indicator itself look like it stuttered.
   * These tools report into the chat once they have actually run, which is the record worth keeping.
   */
  it("shows no live label for a tool that writes no file", async () => {
    const p = new MockProvider([[
      { type: "tool-progress", name: "grep", chars: 68 },
      { type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" },
    ]]);
    const labels: string[] = [];
    await drain(runRoleAgent(opts(p, { onLiveActivity: (l) => labels.push(l) })));
    expect(labels.filter(Boolean)).toEqual([]);
  });

  it("clears the label when the turn's generation ends, so a write label cannot linger", async () => {
    const p = new MockProvider([[
      { type: "tool-progress", name: "write_file", chars: 900, path: "a/b.ts" },
      { type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" },
    ]]);
    const labels: string[] = [];
    await drain(runRoleAgent(opts(p, { onLiveActivity: (l) => labels.push(l) })));
    expect(labels).toContain("writing b.ts · 900 chars");
    expect(labels.at(-1)).toBe("");
  });
});

describe("runRoleAgent fallback chain", () => {
  it("retryable error on the primary → falls back to the next model and succeeds", async () => {
    const p = new MockProvider([
      [{ type: "error", message: "429 rate limited", retryable: true }], // primary "m" is exhausted
      [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }], // fallback "f1" answers
    ]);
    const exhausted: string[] = [];
    const falls: { from: string; to: string }[] = [];
    const events = await drain(runRoleAgent(opts(p, {
      fallbacks: ["f1"],
      onExhausted: (m) => exhausted.push(m),
      onFallback: (from, to) => falls.push({ from, to }),
    })));
    expect(p.requests.map((r) => r.model)).toEqual(["m", "f1"]); // tried primary, then fallback
    expect(exhausted).toEqual(["m"]);
    expect(falls).toEqual([{ from: "m", to: "f1" }]);
    expect(events.at(-1)).toEqual({ type: "message.done", message: { role: "assistant", content: "ok" } });
  });

  it("walks the whole chain, then surfaces the error when nothing is left", async () => {
    const p = new MockProvider([
      [{ type: "error", message: "429", retryable: true }],
      [{ type: "error", message: "503", retryable: true }],
      [{ type: "error", message: "429 again", retryable: true }],
    ]);
    const exhausted: string[] = [];
    const events = await drain(runRoleAgent(opts(p, { fallbacks: ["f1", "f2"], onExhausted: (m) => exhausted.push(m) })));
    expect(p.requests.map((r) => r.model)).toEqual(["m", "f1", "f2"]);
    expect(exhausted).toEqual(["m", "f1", "f2"]); // all three spent
    expect(events.at(-1)).toEqual({ type: "error", message: "429 again", retryable: true });
  });

  it("a NON-retryable error does not fall back", async () => {
    const p = new MockProvider([[{ type: "error", message: "401 unauthorized" }]]);
    const exhausted: string[] = [];
    const events = await drain(runRoleAgent(opts(p, { fallbacks: ["f1"], onExhausted: (m) => exhausted.push(m) })));
    expect(p.requests.map((r) => r.model)).toEqual(["m"]); // no fallback attempted
    expect(exhausted).toEqual([]); // not marked exhausted
    expect(events.at(-1)).toEqual({ type: "error", message: "401 unauthorized", retryable: undefined });
  });

  it("does not fall back once text has already streamed (can't cleanly retry)", async () => {
    const p = new MockProvider([
      [{ type: "text-delta", text: "partial" }, { type: "error", message: "stream stalled", retryable: true }],
    ]);
    const events = await drain(runRoleAgent(opts(p, { fallbacks: ["f1"] })));
    expect(p.requests.map((r) => r.model)).toEqual(["m"]); // no retry — output was already emitted
    expect(events).toContainEqual({ type: "message.delta", text: "partial" });
    expect(events.at(-1)).toEqual({ type: "error", message: "stream stalled", retryable: true });
  });
});

// A RETURNING task must rewrite files it wrote in an EARLIER attempt, and a fresh run has no record of
// reading them. Guarding those writes refused every one of them, so the attempt produced nothing at all —
// which the pipeline reported as "the implementer wrote nothing" and escalated to a stronger model.
//
// The guard's premise is that an overwrite is irrecoverable. For an agent whose every write is committed as
// it happens (`onWrite`), it is not: git holds every version.
describe("the blind-overwrite guard is scoped to agents that do NOT commit every write", () => {
  const writeTurn = (path: string): ChatEvent[] => [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content: "v2" }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
  const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

  const run = async (dir: string, onWrite?: (p: string) => Promise<void>) => {
    const { writeFileTool } = await import("../../src/tools/write.js");
    const { readFileTool } = await import("../../src/tools/read.js");
    const p = new MockProvider([writeTurn("a.ts"), doneTurn]);
    const results: string[] = [];
    for await (const ev of runRoleAgent(opts(p, {
      tools: registry(writeFileTool, readFileTool), cwd: dir,
      ...(onWrite ? { onWrite } : {}),
    }))) {
      if (ev.type === "tool.result") results.push(ev.result.content);
    }
    return results.join("\n");
  };

  it("an agent that commits every write may overwrite without re-reading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-gw-"));
    try {
      await writeFile(join(dir, "a.ts"), "v1", "utf8");
      const out = await run(dir, async () => {});
      expect(out).toContain("Written: a.ts");
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("v2");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("an agent whose writes are NOT committed is still guarded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-gw-"));
    try {
      await writeFile(join(dir, "a.ts"), "v1", "utf8");
      const out = await run(dir); // no onWrite → the conflict-resolver shape
      expect(out).toMatch(/read_file it first/);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("v1"); // untouched
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
