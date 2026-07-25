import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAcceptance } from "../../src/engine/acceptance.js";
import { Board } from "../../src/board/board.js";
import type { Provider } from "../../src/core/types.js";
import { reviewBodies } from "../support/review-bodies.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { fakeSpecKit } from "../support/fake-speckit.js";
import type { ReviewDeps } from "../../src/engine/review.js";

const gdeps = (provider: Provider): ReviewDeps => ({
  provider,
  roleRegistry: new RoleRegistry({ "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" } }, {}, new SkillRegistry()),
  skillRegistry: new SkillRegistry(),
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  signal: new AbortController().signal,
  specKit: fakeSpecKit,
  ...reviewBodies(),
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-gate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const card = (acceptance: string[]) => {
  const b = new Board();
  return b.addCard({ id: "t1", title: "add the Todo model", acceptance });
};
const provider = (checks: unknown): Provider => ({
  async *chat() {
    yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ checks }) } };
    yield { type: "done", finishReason: "tool_calls" };
  },
});

describe("verifyAcceptance (the completion gate)", () => {
  it("passes trivially when the task promised nothing (plans that predate the gate still run)", async () => {
    const res = await verifyAcceptance(gdeps(provider([])), card([]), dir);
    expect(res).toEqual({ passed: true, unmet: [] });
  });

  it("passes when every criterion is met, and reports it", async () => {
    const crit = ["src/models/todo.ts exports a Todo type", "a test covers toggling done"];
    const p = provider(crit.map((c) => ({ criterion: c, met: true, evidence: "saw it in src/models/todo.ts" })));
    const notes: string[] = [];
    const res = await verifyAcceptance(gdeps(p), card(crit), dir, (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(res.passed).toBe(true);
    expect(notes.join("\n")).toMatch(/all 2 criteria verified/i);
  });

  it("fails with the evidence when a criterion is not met", async () => {
    const crit = ["src/models/todo.ts exports a Todo type", "a test covers toggling done"];
    const p = provider([
      { criterion: crit[0], met: true, evidence: "found the export" },
      { criterion: crit[1], met: false, evidence: "no test file references toggle" },
    ]);
    const res = await verifyAcceptance(gdeps(p), card(crit), dir);
    expect(res.passed).toBe(false);
    expect(res.unmet).toEqual(["a test covers toggling done — no test file references toggle"]);
  });

  it("a criterion the gate stayed SILENT about is not satisfied", async () => {
    const crit = ["src/models/todo.ts exports a Todo type", "a test covers toggling done"];
    const p = provider([{ criterion: crit[0], met: true, evidence: "found it" }]); // second one never reported
    const res = await verifyAcceptance(gdeps(p), card(crit), dir);
    expect(res.passed).toBe(false);
    expect(res.unmet[0]).toMatch(/not reported by the acceptance gate/);
  });

  it("a gate that cannot run treats the criteria as UNMET (never waves the task through)", async () => {
    const broken: Provider = { async *chat() { yield { type: "text-delta", text: "I think it is fine" }; yield { type: "done", finishReason: "stop" }; } };
    const res = await verifyAcceptance(gdeps(broken), card(["src/models/todo.ts exports a Todo type"]), dir);
    expect(res.passed).toBe(false);
    expect(res.unmet[0]).toMatch(/not verified/);
  });
});
