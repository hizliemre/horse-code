import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskWithEscalation, tierOf, autonomousAskHuman } from "../../src/engine/escalation.js";
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
const contents = (p: MockProvider): string[] =>
  p.requests.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")));

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
    expect(sys).toContain("P-coder");
    expect(sys).toContain("P-senior-coder");
    expect(sys).toContain("P-architect");
  });

  it("designer family (N=1): designer fail → senior-designer takes over", async () => {
    const p = new MockProvider([
      submit('{"role":"designer"}'),
      noopImpl, ...codeReviewFail("a"),   // tier0 designer fail
      noopImpl, ...codeReviewPass(),      // tier1 senior-designer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys).toContain("P-designer");
    expect(sys).toContain("P-senior-designer");
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

// A no-op attempt is not a near miss to iterate on: nothing was written, so the SAME role given the SAME
// instruction produces the same nothing. `tierOf` would otherwise spend every remaining same-tier retry
// proving it — which is the "→ rework / wrote nothing / → In progress" churn seen in the wild.
describe("a no-op attempt escalates immediately instead of burning same-tier retries", () => {
  it("jumps to the next tier rather than repeating the same role `rounds` times", async () => {
    const p = new MockProvider([submit('{"role":"coder"}'), ...Array.from({ length: 12 }, () => noopImpl)]);
    const board = boardWithTask();
    await runTaskWithEscalation(edeps(p, { rounds: 3 }), board, "t1", dir);
    // Each tier gets exactly ONE no-op attempt, not `rounds` of them…
    expect(board.get("t1")!.stageHistory.filter((s) => s.action === "no-changes").length).toBeLessThanOrEqual(2);
    // …so the attempt counter lands on tier boundaries and never grinds in between.
    expect(board.get("t1")!.attempts % 3).toBe(0);
  });
});
