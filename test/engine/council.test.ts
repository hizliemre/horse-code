import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEscalationCouncil } from "../../src/engine/council.js";
import { initTmpRepo } from "../worktree/helpers.js";
import { Telemetry, setTelemetry, NO_TELEMETRY } from "../../src/obs/telemetry.js";
import { MemorySink } from "../../src/obs/sink.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-council-")); });
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

function deps(provider: MockProvider): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = {
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "Do X" });
  return b;
}

describe("runEscalationCouncil", () => {
  it("pass: architect diagnosis → senior implements → reviewer pass; stage records + senior sees the plan", async () => {
    // architect submit → senior write → senior done → reviewer pass
    const p = new MockProvider([
      submit('{"rootCause":"missing tests","plan":["add tests","fix the code"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    const actions = c.stageHistory.map((s) => s.action);
    expect(actions).toContain("council:diagnosed");
    expect(actions).toContain("council:implemented");
    expect(actions).toContain("reviewed:pass");
    // senior implement (requests[1]) saw the architect's plan (reviewNotes) in its message
    expect(p.requests[1].messages[0].content).toContain("P-senior-coder");
    expect(p.requests[1].messages.some((m) => typeof m.content === "string" && m.content.includes("add tests"))).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("code");
  });

  it("fail: reviewer fail → Verdict returns fail, not moved to DONE (stays in REVIEW)", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"fail","notes":["still failing"]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("fail");
    expect(v.notes).toEqual(["still failing"]);
    expect(board.get("t1")!.column).toBe("REVIEW");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("reviewed:fail");
  });

  it("designer family: senior-designer implements", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    await runEscalationCouncil(deps(p), board, "t1", dir, "designer");
    expect(p.requests[1].messages[0].content).toContain("P-senior-designer");
  });
});

/**
 * The council's senior implementation went to REVIEW whatever happened — it had no no-change check, unlike
 * every other implementer.
 *
 * Measured live: five tasks each ran a council implementation of ONE turn and ZERO tool calls, moved to
 * review with an unchanged worktree, and the reviewer spent all 25 of its turns hunting for a change that was
 * not there before failing with "tool call budget exceeded before review could be conducted". Every one of
 * those reviews was pure cost: there was nothing to judge.
 */
describe("the council does not send an unchanged worktree to review", () => {
  it("fails the round instead, and says which model wrote nothing", async () => {
    const repo = await initTmpRepo();
    try {
      // architect diagnoses, then the senior answers in prose and writes nothing.
      const p = new MockProvider([submit('{"rootCause":"r","plan":["p"]}'), doneTurn]);
      const board = boardWithTask();
      const notes: string[] = [];
      const v = await runEscalationCouncil({ ...deps(p), note: (t) => notes.push(t) }, board, "t1", repo, "coder");
      expect(v.verdict).toBe("fail");
      expect(board.get("t1")!.column).toBe("TODO");                        // not REVIEW
      expect(board.get("t1")!.stageHistory.some((h) => h.action === "no-changes")).toBe(true);
      expect(board.get("t1")!.stageHistory.some((h) => h.action === "council:implemented")).toBe(false);
      expect(notes.join("\n")).toMatch(/wrote nothing/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** And when it DOES write, nothing changes: the round proceeds to its review exactly as before. */
  it("still reviews an implementation that actually wrote something", async () => {
    const repo = await initTmpRepo();
    try {
      const p = new MockProvider([
        submit('{"rootCause":"r","plan":["p"]}'),
        writeTurn(), doneTurn,
        submit('{"verdict":"pass","notes":[]}'),
      ]);
      const board = boardWithTask();
      const v = await runEscalationCouncil(deps(p), board, "t1", repo, "coder");
      expect(v.verdict).toBe("pass");
      expect(board.get("t1")!.stageHistory.some((h) => h.action === "council:implemented")).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

/**
 * Only the normal cycle's team review was wrapped in a span, so a task that reached the council — which is
 * every task that has failed a few times, i.e. exactly the ones a run gets stuck on — spent its review time
 * invisibly. A live run showed `code review 0m/0x` while tasks were passing review and merging.
 */
describe("the council's review is measured too", () => {
  it("opens a code_review span, marked as the council's", async () => {
    const repo = await initTmpRepo();
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));
    try {
      const p = new MockProvider([
        submit('{"rootCause":"r","plan":["p"]}'),
        writeTurn(), doneTurn,
        submit('{"verdict":"pass","notes":[]}'),
      ]);
      await runEscalationCouncil(deps(p), boardWithTask(), "t1", repo, "coder");
      const span = sink.records.find((r) => r.kind !== "event" && r.name === "stage.code_review");
      expect(span).toBeDefined();
      expect(span?.attributes["hc.task.id"]).toBe("t1");
      expect(span?.attributes["hc.council"]).toBe(true);
    } finally {
      setTelemetry(NO_TELEMETRY);
      await rm(repo, { recursive: true, force: true });
    }
  });
});
