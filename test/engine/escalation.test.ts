import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskWithEscalation, tierOf, autonomousAskHuman, noChangeStreak, FLEET_PATIENCE, isFleetFailure } from "../../src/engine/escalation.js";
import type { EscalationDeps, AskHuman } from "../../src/engine/escalation.js";
import type { Card } from "../../src/board/board.js";
import type { Verdict } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";
import { reviewBodies, codeReviewPass, codeReviewFail } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-esc-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function writeTurn(): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: '{"path":"out.txt","content":"code"}' } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "done" }, { type: "done", finishReason: "stop" }];
// Single-turn implementer (no write — quick pass-through to the reviewer)
const noopImpl: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface EOpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function edeps(provider: MockProvider, opts: EOpts = {}): EscalationDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    designer: { models: ["m"], systemPrompt: "P-designer" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
    rounds: opts.rounds ?? 3,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "Do X" });
  return b;
}
/** Its files make it design work outright, so the router settles it without a call. */
function boardWithDesignTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "Restyle X", files: ["src/ui/x.scss"] });
  return b;
}
const contents = (p: MockProvider): string[] =>
  p.requests.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")));

/**
 * What the ladder must not be charged for, in the gateway's own words.
 *
 * The ladder answers one question — is this task hard? Every message here answers a different one, about a
 * model or the gateway, and each was measured advancing a ladder it had no business advancing. Of 826
 * attempt-errors in one run, 556 were the first three classes (already forgiven, and they abandoned
 * nothing); 157 more were capacity asking for time, and ~57 were transport or a role pointed at an endpoint
 * that cannot serve chat at all.
 */
describe("isFleetFailure — the fleet's problem, not the task's", () => {
  it("reads every wording the gateway actually used", () => {
    for (const m of [
      "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'.",
      "No active credentials for provider: antigravity",
      "[antigravity/claude-sonnet-4-6] All antigravity accounts have exhausted their quota (reset after 4h)",
      "[opencode-go/deepseek-v4-pro] Shared egress IP quota exhausted (opencode-go) (reset after 114h)",
      "Chat admission capacity is temporarily unavailable. Retry shortly.",
      "Structurally heavy chat request capacity is busy; retry shortly.",
      "http://localhost:20128 did not accept a connection in time (ETIMEDOUT)",
      "[400]: Error from provider (Console Go): Upstream request failed",
      "[403]: The latest version of this model is only available hosted",
      "Model 'antigravity/gemini-3.1-flash-image' is an image-generation model",
      /**
       * The sentence that ended a 119-minute run. Every one of its five root tasks exhausted its ladder on
       * this and nothing else — T013 saw it 31 times, T055 43 — and those five blocked 101 more, leaving 19
       * of 125 merged. Probed straight afterwards the same model answered the same request in 200: the
       * gateway rotates between two accounts and one lacks the beta, so the task was charged for which
       * account it landed on.
       */
      "The long context beta is not yet available for this subscription.",
    ]) {
      expect(isFleetFailure(m), m).toBe(true);
    }
  });

  /**
   * Context OVERFLOW is the opposite case and must keep charging: the prompt really was too big, so the
   * task learned something about itself and the ladder is the right place to record it. `isCapabilityError`
   * covers both wordings; only the subscription one is the fleet's.
   */
  it("still charges when the request itself was too big", () => {
    for (const m of ["context length exceeded", "too many tokens", "maximum context reached"]) {
      expect(isFleetFailure(m), m).toBe(false);
    }
  });

  /**
   * A task that ran out of time or turns WAS attempted — that is a fact about the work, and the ladder is
   * exactly the right place to record it. Forgiving these would make the ladder unable to escalate at all.
   */
  it("still charges for failures that are about the work", () => {
    for (const m of [
      "the implementer ran past its 20-minute budget for a single attempt and was stopped",
      "maximum turn count exceeded (200)",
      "the model did not answer within its deadline",
    ]) {
      expect(isFleetFailure(m), m).toBe(false);
    }
  });
});

describe("tierOf", () => {
  it("attempts/rounds → tier", () => {
    expect(tierOf(0, 1)).toBe(0);
    expect(tierOf(1, 1)).toBe(1);
    expect(tierOf(2, 1)).toBe(2);
    expect(tierOf(0, 3)).toBe(0);
    expect(tierOf(2, 3)).toBe(0);
    expect(tierOf(3, 3)).toBe(1);
    expect(tierOf(5, 3)).toBe(1);
    expect(tierOf(6, 3)).toBe(2);
  });
});

describe("runTaskWithEscalation", () => {
  it("tier progression (N=1): coder fail → senior-coder fail → council pass → DONE", async () => {
    const p = new MockProvider([
      submit('{"role":"coder"}'),                    // route → coder family
      noopImpl, ...codeReviewFail("a"),   // tier0 coder fail
      noopImpl, ...codeReviewFail("b"),   // tier1 senior-coder fail
      submit('{"rootCause":"x","plan":["p"]}'),      // council: architect
      writeTurn(), doneTurn,                         // council: senior-coder implement
      submit('{"verdict":"pass","notes":[]}'),       // council: reviewer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.attempts).toBe(2);
    // each tier used the right role
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys.some((x) => x.includes("P-coder"))).toBe(true);
    expect(sys.some((x) => x.includes("P-senior-coder"))).toBe(true);
    expect(sys.some((x) => x.includes("P-architect"))).toBe(true);
  });

  it("designer family (N=1): designer fail → senior-designer takes over", async () => {
    const p = new MockProvider([
      noopImpl, ...codeReviewFail("a"),   // tier0 designer fail
      noopImpl, ...codeReviewPass(),      // tier1 senior-designer pass
    ]);
    const board = boardWithDesignTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys.some((x) => x.includes("P-designer"))).toBe(true);
    expect(sys.some((x) => x.includes("P-senior-designer"))).toBe(true);
  });

  it("an attempt that THROWS (turn-count ceiling) escalates to the next tier — does NOT kill the task", async () => {
    const p = new MockProvider([
      submit('{"role":"coder"}'),                                          // route → coder
      [{ type: "error", message: "maximum turn count exceeded (200)" }],   // tier0 implementer THROWS
      noopImpl, ...codeReviewPass(),                   // tier1 senior-coder passes
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass"); // the throw at tier0 escalated to senior, which succeeded
    expect(board.get("t1")!.column).toBe("DONE");
    const stages = board.get("t1")!.stageHistory;
    expect(stages.some((s) => s.action === "attempt-error" && /turn count/.test(s.note ?? ""))).toBe(true);
  });

  /**
   * A task must not pay the ladder for a model it could never reach.
   *
   * Measured live: T002 spent all eight of its attempts inside four minutes on
   * `muse-spark-1.2-contributor-xhigh`, a model the gateway lists and refuses to route to. Twenty-three
   * parallel slots were re-assigned to it at once and every answer charged a task an attempt, so T002
   * reached "ladder exhausted" and parked — with ninety-six dependent tasks behind it — without a single
   * model having read the work.
   */
  it("does not spend an attempt when no model could be reached", async () => {
    const unroutable = "Model 'muse-spark-1.2-contributor-xhigh' is not available in the active live catalog for provider 'opencode-go'.";
    const p = new MockProvider([
      submit('{"role":"coder"}'),          // route → coder
      [{ type: "error", message: unroutable }],  // the fleet, not the work
      noopImpl, ...codeReviewPass(),       // the retry reaches a model and passes
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    // Still tier 0: the ladder never advanced, because nothing about the task had been learned.
    expect(board.get("t1")!.attempts).toBe(0);
    const notes = board.get("t1")!.stageHistory.filter((s) => s.action === "attempt-error");
    expect(notes.some((s) => /not available in the active live catalog/.test(s.note ?? ""))).toBe(true);
  });

  /**
   * Patience is bounded, and running out means PARK, not abandon.
   *
   * A quota of two forgiven attempts was the first shape of this and the run disproved it: the twenty-one
   * tasks caught by one unroutable model saw between nine and forty-five fleet failures each, so saving two
   * of eight changed nothing. The bound has to end in the state that says "nothing this task can do until
   * something changes" — which is the only state the wave engine can wake from.
   */
  it("gives up waiting after FLEET_PATIENCE consecutive fleet failures, without spending the ladder", async () => {
    const unroutable = "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'.";
    const fleetTurn = [{ type: "error" as const, message: unroutable }];
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      ...Array.from({ length: FLEET_PATIENCE }, () => fleetTurn),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    expect(v.fleetDown).toBe(true);          // the caller must park it, not abandon it
    expect(board.get("t1")!.attempts).toBe(0); // and the ladder was never charged
  });

  /** The advice has to match what happened: "work faster" is wrong when nothing was ever asked. */
  it("does not tell the next attempt to hurry when no model answered", async () => {
    const unroutable = "No active credentials for provider: antigravity";
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      [{ type: "error", message: unroutable }],
      noopImpl, ...codeReviewPass(),
    ]);
    const board = boardWithTask();
    await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    const sent = JSON.stringify(p.requests.map((r) => r.messages));
    expect(sent).not.toContain("Complete the task within the turn budget");
    expect(sent).toContain("never reached a model");
  });

  it("autonomousAskHuman: retries a bounded number of times with the notes, then abandons (no prompt)", async () => {
    const ask = autonomousAskHuman(2);
    const card = { id: "t1" } as Card;
    const verdict: Verdict = { verdict: "fail", notes: ["fix the thing"] };
    expect(await ask({ card, verdict })).toEqual({ action: "retry", notes: ["fix the thing"] });
    expect(await ask({ card, verdict })).toEqual({ action: "retry", notes: ["fix the thing"] });
    expect(await ask({ card, verdict })).toEqual({ action: "abandon" }); // budget exhausted
    // per-task budget: a different card starts fresh
    expect(await ask({ card: { id: "t2" } as Card, verdict })).toEqual({ action: "retry", notes: ["fix the thing"] });
  });

  it("council fail → askHuman accept → DONE (human:accept), verdict pass", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "accept" }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, ...codeReviewFail("a"),
      noopImpl, ...codeReviewFail("b"),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:accept");
  });

  it("council fail → askHuman retry → council retries; second architect round sees the hint", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["hint-XYZ"] }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, ...codeReviewFail("a"),
      noopImpl, ...codeReviewFail("b"),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'), // council round 1 fail
      submit('{"rootCause":"y","plan":["q"]}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}'),   // council round 2 pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    // after the retry, the second council round's architect message contains the hint (reviewNotes)
    expect(contents(p).some((c) => c.includes("hint-XYZ"))).toBe(true);
  });

  it("council fail → askHuman abandon → verdict fail, not moved to DONE (human:abandon)", async () => {
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, ...codeReviewFail("a"),
      noopImpl, ...codeReviewFail("b"),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    expect(board.get("t1")!.column).not.toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:abandon");
  });

  it("unknown task → error", async () => {
    const p = new MockProvider([]);
    await expect(runTaskWithEscalation(edeps(p), boardWithTask(), "missing", dir)).rejects.toThrow(/unknown task/);
  });

  it("throws if cancelled (abort is not swallowed)", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"role":"coder"}')]);
    await expect(
      runTaskWithEscalation(edeps(p, { signal: ac.signal }), boardWithTask(), "t1", dir),
    ).rejects.toThrow();
  });
});

/**
 * A no-op attempt used to jump a whole tier at once, on the reasoning that the same role given the same
 * instruction produces the same nothing. It does not: `runCycleWithRole` leads with `slot + attempts` of the
 * chain, so the next attempt is a DIFFERENT model — and answering in prose instead of calling write_file is a
 * property of the model, not the role.
 *
 * Measured on a real 94-task board: 41 no-op attempts pushed tasks to attempt counts of 6, 8 and 12, so
 * everything ran at council tier and the plain coder finished only 4 of the 28 completed tasks.
 */
describe("no-change circuit breaker", () => {
  it("escalates to a human after three no-change transitions instead of dispatching again", async () => {
    const board = boardWithTask();
    for (let i = 0; i < 3; i++) {
      board.appendStage("t1", { role: "coder", action: "no-changes", note: `attempt ${i + 1}` });
    }
    const askHuman: AskHuman = async ({ verdict }) => {
      expect(verdict.notes[0]).toMatch(/three attempts produced no file changes/i);
      return { action: "abandon" };
    };
    const p = new MockProvider([submit('{"role":"coder"}')]);

    const v = await runTaskWithEscalation(edeps(p, { askHuman }), board, "t1", dir);

    expect(v.verdict).toBe("fail");
    expect(board.get("t1")!.stageHistory.some((s) => s.action === "human:required")).toBe(true);
    expect(contents(p).some((x) => x.includes("P-coder") || x.includes("P-senior-coder") || x.includes("P-architect"))).toBe(false);
  });
});

describe("a no-op attempt tries the role's next model before spending a stronger role", () => {
  it("advances one attempt — a different model, same tier — on the first no-op", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), noopImpl, ...codeReviewPass()]);
    const board = boardWithTask();
    board.incrementAttempts("t1"); // mid-tier already (rounds=3 → tier 0 spans 0..2)
    await runTaskWithEscalation(edeps(p, { rounds: 3 }), board, "t1", dir);
    const roles = p.requests.map((r) => r.messages[0].content);
    expect(roles.some((x) => x.includes("P-coder"))).toBe(true);
    expect(roles.some((x) => x.includes("P-senior-coder"))).toBe(false); // the tier was not spent
  });

  it("escalates once the tier's second model has also written nothing", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), ...Array.from({ length: 12 }, () => noopImpl)]);
    const board = boardWithTask();
    await runTaskWithEscalation(edeps(p, { rounds: 3 }), board, "t1", dir);
    // Two tries per tier, not `rounds` of them, and never a third.
    const perTier = board.get("t1")!.stageHistory.filter((s) => s.action === "no-changes").length;
    expect(perTier).toBeLessThanOrEqual(4); // ≤2 tiers × 2 attempts
    expect(board.get("t1")!.attempts % 3).toBe(0); // still lands on a tier boundary
  });

  it("never grinds through a whole tier of no-ops", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), ...Array.from({ length: 20 }, () => noopImpl)]);
    const board = boardWithTask();
    await runTaskWithEscalation(edeps(p, { rounds: 6 }), board, "t1", dir);
    expect(board.get("t1")!.stageHistory.filter((s) => s.action === "no-changes").length).toBeLessThanOrEqual(4);
  });
});

/**
 * The "three attempts produced no file changes" gate used to count the card's WHOLE history, which made it
 * permanent: once a task had ever written nothing three times, every later run hit the gate before the ladder
 * ran at all.
 *
 * Measured live — five tasks were scheduled, each opened and closed its span in 0.0 seconds with no
 * `decision.tier` event between them. They carried three or four no-changes each from earlier runs — enough to trip a
 * lifetime counter forever — and could never be attempted again whatever had been fixed since.
 */
describe("noChangeStreak", () => {
  const card = (...actions: string[]): Card => ({
    id: "t1", title: "t", column: "TODO", deps: [], acceptance: [], files: [], reviewNotes: [],
    attempts: 0, stageHistory: actions.map((action) => ({ role: "coder", action })),
  });

  it("counts the run of empty attempts at the end", () => {
    expect(noChangeStreak(card("no-changes", "no-changes", "no-changes"))).toBe(3);
  });

  /** The case that poisoned five real tasks: old failures with real work after them. */
  it("does not count empty attempts that work has since followed", () => {
    expect(noChangeStreak(card(
      "no-changes", "no-changes", "no-changes", "no-changes",
      "→REVIEW", "reviewed:fail", "→TODO",
    ))).toBe(0);
  });

  it("counts only back to the last thing that happened", () => {
    expect(noChangeStreak(card("no-changes", "reviewed:fail", "no-changes", "no-changes"))).toBe(2);
  });

  /** Column moves and a thrown attempt are bookkeeping around an attempt, not evidence about it. */
  it("looks past the column moves between attempts", () => {
    expect(noChangeStreak(card("no-changes", "→TODO", "→IN-PROGRESS", "no-changes", "→TODO"))).toBe(2);
  });

  it("is zero for a task that has never run", () => {
    expect(noChangeStreak(card())).toBe(0);
  });

  /** A reset is a human saying "start over"; it must clear the streak like any other real event. */
  it("stops at a reset", () => {
    expect(noChangeStreak(card("no-changes", "no-changes", "reset", "no-changes"))).toBe(1);
  });
});
