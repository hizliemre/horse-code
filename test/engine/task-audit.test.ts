import { describe, it, expect } from "vitest";
import { auditBreakdown, structuralFindings, restatesTitle, repairRequest } from "../../src/engine/task-audit.js";
import { Board } from "../../src/board/board.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";
import type { ChatEvent } from "../../src/core/types.js";

const opts = (provider: MockProvider): RoleAgentOptions => ({
  provider,
  model: "m",
  systemPrompt: "you audit the breakdown",
  tools: new ToolRegistry(),
  messages: [],
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  cwd: "/tmp",
  signal: new AbortController().signal,
});
const submitTurn = (argsJson: string): ChatEvent[] => [
  { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
  { type: "done", finishReason: "tool_calls" },
];

/** A breakdown with nothing wrong with it — the normal case, and the one that must cost nothing extra. */
const goodBoard = (): Board => {
  const b = new Board();
  b.addCard({ id: "t1", title: "add the todo store", files: ["src/store/todo.ts"],
    acceptance: ["src/store/todo.ts exports addTodo and removeTodo"] });
  return b;
};

/**
 * "the model is implemented" for "Implement the model" is not a completion gate — it is the title with a
 * verb moved. A real criterion names something outside the title: a path, an export, a command.
 */
describe("restatesTitle", () => {
  it("catches a criterion that only says the task is done", () => {
    expect(restatesTitle("Implement the Todo model", "the Todo model is implemented")).toBe(true);
    expect(restatesTitle("Add the store", "the store is added and works correctly")).toBe(true);
  });

  it("accepts a criterion that names something checkable", () => {
    expect(restatesTitle("Implement the Todo model", "src/models/todo.ts exports a Todo type")).toBe(false);
    expect(restatesTitle("Add the store", "calling addTodo twice yields two entries")).toBe(false);
  });
});

describe("structuralFindings", () => {
  it("finds a task nothing decides the completion of", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "do it", files: ["src/a.ts"] });
    expect(structuralFindings(b)[0].issue).toMatch(/no acceptance criteria/);
  });

  it("finds a task whose criteria all restate its title", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "build the parser", files: ["src/p.ts"], acceptance: ["the parser is built"] });
    expect(structuralFindings(b)[0].issue).toMatch(/restates the title/);
  });

  /** Without them nothing can tell whether two tasks collide — which is what decides the schedule. */
  it("finds a task that names no files", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "add the store", acceptance: ["src/store.ts exports addTodo"] });
    expect(structuralFindings(b).some((f) => f.issue.includes("names no files"))).toBe(true);
  });

  it("finds two tasks that are the same task twice", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "Add the store", files: ["a.ts"], acceptance: ["a.ts exports x"] });
    b.addCard({ id: "t2", title: "add the store", files: ["b.ts"], acceptance: ["b.ts exports y"] });
    expect(structuralFindings(b).some((f) => f.issue.includes("same title"))).toBe(true);
  });

  it("says nothing about a breakdown that is fine", () => {
    expect(structuralFindings(goodBoard())).toEqual([]);
  });

  /** One criterion carrying real content is enough — the others may well be summaries of it. */
  it("does not flag a task whose criteria are only partly loose", () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "add the store", files: ["src/store.ts"],
      acceptance: ["the store is added", "src/store.ts exports addTodo"] });
    expect(structuralFindings(b)).toEqual([]);
  });
});

describe("auditBreakdown", () => {
  /** The structural pass is free; only the reading question — was anything dropped? — is worth a call. */
  it("does not pay for a reading pass when the structure is already wrong", async () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "do it" });
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[]}')]);
    const r = await auditBreakdown(opts(p), b, "# plan");
    expect(r.asked).toBe(false);
    expect(p.requests).toHaveLength(0);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("reports a plan requirement no task delivers", async () => {
    const p = new MockProvider([submitTurn('{"missing":["the app must persist todos to localStorage"],"weak":[]}')]);
    const r = await auditBreakdown(opts(p), goodBoard(), "# plan\nPersist todos to localStorage.");
    expect(r.asked).toBe(true);
    expect(r.findings[0].issue).toMatch(/localStorage/);
  });

  it("reports a task whose criteria would pass a wrong implementation", async () => {
    const p = new MockProvider([submitTurn('{"weak":[{"task":"t1","issue":"an empty file would satisfy it"}]}')]);
    const r = await auditBreakdown(opts(p), goodBoard(), "# plan");
    expect(r.findings).toEqual([{ task: "t1", issue: "an empty file would satisfy it" }]);
  });

  it("ignores a task id the audit invented", async () => {
    const p = new MockProvider([submitTurn('{"weak":[{"task":"nope","issue":"x"}]}')]);
    expect((await auditBreakdown(opts(p), goodBoard(), "# plan")).findings).toEqual([]);
  });

  it("gives the auditor the plan and the criteria, not just the titles", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[]}')]);
    await auditBreakdown(opts(p), goodBoard(), "# plan\nPersist todos.");
    const sent = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("Persist todos.");
    expect(sent).toContain("exports addTodo and removeTodo");
  });

  /** Before the gate existed the breakdown was used unchecked; a broken gate must land exactly there. */
  it("finds nothing when the call fails, rather than failing the job", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "hmm" }, { type: "done", finishReason: "stop" }]]);
    expect((await auditBreakdown(opts(p), goodBoard(), "# plan")).findings).toEqual([]);
  });

  /** A gate that cannot be configured away beats one that takes the job down when it is. */
  it("still runs the structural pass when no auditor role is configured", async () => {
    const b = new Board();
    b.addCard({ id: "t1", title: "do it" });
    const r = await auditBreakdown(undefined, b, "# plan");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.asked).toBe(false);
  });

  it("does not fall back when aborted, rethrows the error", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submitTurn('{"missing":[]}')]);
    await expect(auditBreakdown({ ...opts(p), signal: ac.signal }, goodBoard(), "# plan")).rejects.toThrow();
  });
});

describe("repairRequest", () => {
  it("asks for a repair, not a rewrite — the ids downstream work is keyed to must survive", () => {
    const req = repairRequest([{ task: "t1", issue: "has no acceptance criteria" }]);
    expect(req).toContain("t1: has no acceptance criteria");
    expect(req).toMatch(/repair, not a rewrite/);
  });
});

/**
 * Coverage was checked in one direction and the expensive gap was the other one.
 *
 * Measured on a live 124-task breakdown: `T001 — Backend: Supplier entity model` invented a `Supplier`
 * entity and a `SupplierContext` the spec never described — the spec asks for `SupplierRelationship`. The
 * implementer built what the task said; the code reviewer rejected it for not matching the spec. Six
 * attempts across two roles, then abandoned, with 117 tasks parked behind it that were never attempted.
 * Four of 124 landed.
 *
 * A task nothing asked for does not merely waste work. It deadlocks, because the two halves of the pipeline
 * are reading different documents and each is right about its own.
 */
describe("a task the plan never asked for", () => {
  const wellFormed = (): Board => {
    const b = new Board();
    b.addCard({ id: "T001", title: "Backend: Supplier entity model",
      acceptance: ["src/domain/Supplier.cs defines a Supplier entity", "the DbContext registers Supplier"],
      files: ["src/domain/Supplier.cs"] });
    return b;
  };

  it("is reported, and names what the plan says instead", async () => {
    const p = new MockProvider([submitTurn(JSON.stringify({
      missing: [], weak: [],
      fabricated: [{ task: "T001", issue: "invents a `Supplier` entity; the plan describes `SupplierRelationship`" }],
    }))]);
    const r = await auditBreakdown(opts(p), wellFormed(), "# plan\nSupplierRelationship is the entity.");
    expect(r.asked).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.task).toBe("T001");
    expect(r.findings[0]?.issue).toContain("the plan does not ask for this");
    expect(r.findings[0]?.issue).toContain("SupplierRelationship");
  });

  it("is asked about at all — the question has to reach the auditor", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[],"fabricated":[]}')]);
    await auditBreakdown(opts(p), wellFormed(), "# plan");
    const sent = JSON.stringify(p.requests[0]?.messages ?? []);
    expect(sent).toContain("fabricated");
    expect(sent).toContain("never asks for");
  });

  /** An auditor naming a card that does not exist has answered about something else. */
  it("ignores a finding against a task the board does not have", async () => {
    const p = new MockProvider([submitTurn(JSON.stringify({
      missing: [], weak: [], fabricated: [{ task: "T999", issue: "invents things" }],
    }))]);
    const r = await auditBreakdown(opts(p), wellFormed(), "# plan");
    expect(r.findings).toEqual([]);
  });

  /** An auditor that answers the old shape must not break: the field defaults to empty. */
  it("accepts a reply that predates the question", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[]}')]);
    const r = await auditBreakdown(opts(p), wellFormed(), "# plan");
    expect(r.asked).toBe(true);
    expect(r.findings).toEqual([]);
  });
});

/**
 * The cheap check could veto the expensive one on the board that ships.
 *
 * Measured live, on the run that this whole audit was strengthened for: the regenerated 124-card board
 * carried 11 structural findings — all of them "names no files", a blemish that does not prevent reading
 * anything — and the reading question was therefore skipped on BOTH passes. The run then spent itself on
 * tasks nobody had checked against the plan, which is the exact failure the question exists to catch.
 *
 * Skipping a model call on a board about to be rewritten is the right economy. Skipping it on the board
 * that gets built is not.
 */
describe("asking the reading question on the board that will actually be built", () => {
  const blemished = (): Board => {
    const b = new Board();
    b.addCard({ id: "T1", title: "Backend: Supplier entity model",
      acceptance: ["src/domain/Supplier.cs defines Supplier"], files: [] }); // no files → structural finding
    return b;
  };

  it("skips the call by default, while the board is still going back for repair", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[],"fabricated":[]}')]);
    const r = await auditBreakdown(opts(p), blemished(), "# plan");
    expect(r.asked).toBe(false);
    expect(p.requests).toHaveLength(0);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("asks anyway when told to, and finds what the structural pass cannot see", async () => {
    const p = new MockProvider([submitTurn(JSON.stringify({
      missing: [], weak: [],
      fabricated: [{ task: "T1", issue: "invents a `Supplier` entity; the plan describes `SupplierRelationship`" }],
    }))]);
    const r = await auditBreakdown(opts(p), blemished(), "# plan", true);
    expect(r.asked).toBe(true);
    expect(r.findings.some((f) => f.issue.includes("the plan does not ask for this"))).toBe(true);
  });

  /** Both are true at once, and reporting only one of them would call a blemished board clean. */
  it("carries the structural findings through alongside what it read", async () => {
    const p = new MockProvider([submitTurn('{"missing":[],"weak":[],"fabricated":[]}')]);
    const r = await auditBreakdown(opts(p), blemished(), "# plan", true);
    expect(r.asked).toBe(true);
    expect(r.findings.some((f) => f.issue.includes("names no files"))).toBe(true);
  });
});
