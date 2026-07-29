import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImplementer, deadlineWarning, attemptBudget, DEADLINE_WARNING_AT, MAX_BUDGET_EXTENSIONS } from "../../src/engine/implementer.js";
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
  id: "t1", title: "write file", column: "IN-PROGRESS", deps: [], acceptance: [], files: [], reviewNotes: [], attempts: 0, stageHistory: [], ...over,
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

/**
 * Measured on a real run: 22 of 26 attempts were killed at exactly 20.0 minutes, each around a hundred turns
 * in. The TIME budget always bit first — the 200-turn budget would need forty minutes at twelve seconds a
 * turn — and it arrived without notice. An agent told it has minutes left can commit what it has; one simply
 * killed leaves the attempt to be redone from nothing.
 */
describe("the implementer is warned before its deadline", () => {
  const seen = (p: MockProvider): string[] =>
    p.requests.flatMap((r) => r.messages.filter((m) => m.role === "user").map((m) => String(m.content)));

  it("says nothing while there is plenty of budget left", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer({ ...deps(p), implementerTimeoutMs: 600_000 }, "coder", card(), dir);
    expect(seen(p).join("\n")).not.toMatch(/budget left/);
  });

  it("says nothing until three quarters of the budget is spent", () => {
    const twenty = 20 * 60 * 1000;
    expect(deadlineWarning(twenty * 0.5, twenty)).toBeUndefined();
    expect(deadlineWarning(twenty * (DEADLINE_WARNING_AT - 0.01), twenty)).toBeUndefined();
    expect(deadlineWarning(twenty * DEADLINE_WARNING_AT, twenty)).toBeDefined();
  });

  /** "Write what you have" is the whole point: a partial implementation on disk is kept and continued from. */
  it("tells it to land what it has rather than keep exploring", () => {
    const w = deadlineWarning(16 * 60 * 1000, 20 * 60 * 1000)!;
    expect(w).toMatch(/4 minute\(s\) of budget left/);
    expect(w).toMatch(/WRITE what you have now/);
    expect(w).toMatch(/Stop exploring/);
  });

  it("never claims zero minutes are left", () => {
    expect(deadlineWarning(20 * 60 * 1000, 20 * 60 * 1000)).toMatch(/1 minute/);
  });
});

/**
 * The implementer was handed the TITLE and nothing else — "This is a NEW task: X. Implement it." — while the
 * card already carried the acceptance criteria it would be judged against and the file list the plan named
 * for it. Every attempt began by rediscovering, from one line, a shape written down two stages earlier.
 *
 * It matters because this is where the time goes: measured over one run, implementation was 86% of all slot
 * time (546 minutes against 35 for review), and the commonest way an attempt ended was running out of budget
 * mid-exploration.
 */
describe("the implementer gets the task's own brief", () => {
  const sent = (p: MockProvider): string =>
    p.requests.flatMap((r) => r.messages.map((m) => String(m.content))).join("\n");

  it("names the acceptance criteria it will be judged against", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card({
      acceptance: ["src/store/todo.ts exports addTodo", "adding twice yields two entries"],
    }), dir);
    expect(sent(p)).toContain("src/store/todo.ts exports addTodo");
    expect(sent(p)).toMatch(/exactly what the review will check/);
  });

  it("names the files the plan expected it to touch", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card({ files: ["src/store/todo.ts", "test/store.spec.ts"] }), dir);
    expect(sent(p)).toContain("src/store/todo.ts");
    expect(sent(p)).toContain("test/store.spec.ts");
  });

  /** A plan written before the code cannot know everything the work will touch. */
  it("says the file list is a starting point, not a fence", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card({ files: ["src/a.ts"] }), dir);
    expect(sent(p)).toMatch(/not a limit on it/);
  });

  it("says nothing extra when the card carries neither", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card(), dir);
    expect(sent(p)).not.toMatch(/It is done when|The plan expects/);
  });

  /** A returning attempt still leads with the notes — that is what it is there to fix. */
  it("keeps the reviewer notes first on a returning task", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card({
      reviewNotes: ["the store never persists"], acceptance: ["src/store.ts exports save"],
    }), dir);
    const msg = sent(p);
    expect(msg.indexOf("the store never persists")).toBeLessThan(msg.indexOf("src/store.ts exports save"));
  });
});

/**
 * The ladder answers every failure the same way — escalate to a stronger role — and for a rejected review
 * that is right. For a deadline it is not: measured on a real board, T035 reached its eleventh attempt with
 * the last SIX all ending "ran past its 20-minute budget", never once judged on its code. A stronger model
 * does not make a twenty-minute job fit in twenty minutes.
 */
describe("attemptBudget", () => {
  const BASE = 20 * 60 * 1000;
  const hist = (...actions: [string, string?][]) =>
    actions.map(([action, note]) => ({ role: "coder", action, ...(note ? { note } : {}) }));
  const withHistory = (h: ReturnType<typeof hist>) => card({ stageHistory: h });
  const overran = "the implementer ran past its 20-minute budget for a single attempt and was stopped.";

  it("gives the base budget to a fresh task", () => {
    expect(attemptBudget(card(), BASE)).toBe(BASE);
  });

  it("adds one budget for each deadline death in a row", () => {
    expect(attemptBudget(withHistory(hist(["attempt-error", overran])), BASE)).toBe(2 * BASE);
    expect(attemptBudget(withHistory(hist(["attempt-error", overran], ["attempt-error", overran])), BASE)).toBe(3 * BASE);
  });

  /** More time is not always what is missing — past the cap, something else is wrong. */
  it("stops extending after the cap", () => {
    const many = hist(...Array.from({ length: 6 }, () => ["attempt-error", overran] as [string, string]));
    expect(attemptBudget(withHistory(many), BASE)).toBe((1 + MAX_BUDGET_EXTENSIONS) * BASE);
  });

  /** A rejection means the code was wrong, not that the clock was short. */
  it("resets to the base after a review rejection", () => {
    const h = hist(["attempt-error", overran], ["reviewed:fail", "a critical finding"]);
    expect(attemptBudget(withHistory(h), BASE)).toBe(BASE);
  });

  it("resets after an attempt that wrote nothing", () => {
    expect(attemptBudget(withHistory(hist(["attempt-error", overran], ["no-changes"])), BASE)).toBe(BASE);
  });

  /** A turn-count ceiling or a model error is a different failure — more minutes would not have helped. */
  it("does not extend for an error that is not about time", () => {
    expect(attemptBudget(withHistory(hist(["attempt-error", "maximum turn count exceeded (200)"])), BASE)).toBe(BASE);
  });
});
