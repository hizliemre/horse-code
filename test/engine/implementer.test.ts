import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImplementer } from "../../src/engine/implementer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card, Board } from "../../src/board/board.js";
import type { ChatEvent, Provider } from "../../src/core/types.js";
import type { ProgressEvent } from "../../src/engine/progress.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-impl-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ coder: { models: ["m"], systemPrompt: "you are the coder" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
  };
}
const ideps = (provider: Provider, onProgress?: (ev: ProgressEvent) => void): TaskCycleDeps =>
  ({ ...deps(provider as MockProvider), provider, ...(onProgress ? { onProgress } : {}) });

const card = (over: Partial<Card> = {}): Card => ({
  id: "t1", title: "write file", column: "IN-PROGRESS", deps: [], acceptance: [], reviewNotes: [], attempts: 0, stageHistory: [], ...over,
});
function writeThenDone(): ChatEvent[][] {
  return [
    [
      { type: "tool-call", toolCall: { id: "w1", name: "write_file", arguments: '{"path":"out.txt","content":"hello"}' } },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }],
  ];
}

describe("runImplementer", () => {
  it("implementer writes a file to the worktree (cwd = worktree)", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card(), dir);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello");
  });

  it("returning task's message includes reviewNotes", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }]]);
    await runImplementer(deps(p), "coder", card({ reviewNotes: ["fix the test"] }), dir);
    const msg = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(msg).toContain("RETURNING");
    expect(msg).toContain("fix the test");
  });
});

// Review lenses metered themselves because their own `emit` was threaded down the review call chain; the
// implementer path had no such channel, so its rows showed a bare clock. Both now feed the same renderer.
describe("runImplementer reports per-agent usage", () => {
  it("streams a cumulative total keyed by the CARD id, plus a rename when its chain slides", async () => {
    const events: ProgressEvent[] = [];
    const p: Provider = {
      async *chat(req) {
        yield { type: "usage", promptTokens: 1000, completionTokens: 50 };
        if (!req.messages.some((m) => m.role === "tool")) {
          yield { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", text: "done" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await runImplementer(ideps(p, (ev) => events.push(ev)), "coder", card(), dir);
    const usage = events.filter((e) => e.kind === "agent-usage");
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage.every((e) => e.kind === "agent-usage" && e.id === "t1")).toBe(true);
    // Cumulative, not per-call — the row shows a total.
    const last = usage.at(-1)!;
    expect(last.kind === "agent-usage" && last.promptTokens).toBe(2000);
  });

  it("is silent when no progress sink is wired (headless runs are unaffected)", async () => {
    const p: Provider = {
      async *chat() {
        yield { type: "usage", promptTokens: 10, completionTokens: 1 };
        yield { type: "text-delta", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await expect(runImplementer(ideps(p), "coder", card(), dir)).resolves.toBeUndefined();
  });
});

// The 200-turn budget does not bound TIME: one card was observed running 378 minutes because nothing said
// when to stop. Every write is committed as it happens, so a stopped attempt keeps its partial work.
describe("one implementation attempt is bounded in wall-clock time", () => {
  const hang = (): Provider => ({
    async *chat(_req, signal) {
      await new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      yield { type: "done", finishReason: "stop" };
    },
  });

  it("stops an attempt that runs past its budget and says so", async () => {
    const d = { ...ideps(hang()), implementerTimeoutMs: 150 };
    await expect(runImplementer(d, "coder", card(), dir)).rejects.toThrow(/ran past its .*budget/);
  });

  it("tells the next tier to CONTINUE from the partial work, not start over", async () => {
    const d = { ...ideps(hang()), implementerTimeoutMs: 150 };
    await expect(runImplementer(d, "coder", card(), dir)).rejects.toThrow(/continue from there/i);
  });

  // A timeout is a failed attempt; a Ctrl-C is a cancellation. They must not be conflated.
  it("a real cancellation still propagates as one", async () => {
    const ac = new AbortController();
    const d = { ...ideps(hang()), signal: ac.signal, implementerTimeoutMs: 60_000 };
    const p = runImplementer(d, "coder", card(), dir);
    ac.abort();
    // Whatever the underlying error is, it must NOT be rewritten into "ran past its budget" — that would
    // send a cancelled job up the escalation ladder as if the model had been too slow.
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toThrow(/ran past its/);
  });

  it("a healthy attempt is unaffected", async () => {
    const ok: Provider = {
      async *chat() {
        yield { type: "text-delta", text: "done" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await expect(runImplementer({ ...ideps(ok), implementerTimeoutMs: 60_000 }, "coder", card(), dir)).resolves.toBeUndefined();
  });
});
