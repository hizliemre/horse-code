import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(res.passed).toBe(true);
    expect(res.unmet).toEqual([]);
    // A directory with no manifest has no suite to run, and that is not a failure.
    expect(res.tests).toEqual({ ran: false, passed: true });
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

/**
 * The gate used to read only. Every reviewing agent in this pipeline has read/grep/glob and nothing else, so
 * the whole quality apparatus answered "does this diff look right?" and none of it could answer "does it
 * work?" — the question that matters when changing code that already exists.
 */
describe("the gate runs the project's own tests", () => {
  const withPkg = async (script: string): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "hc-gate-"));
    await writeFile(join(d, "package.json"), JSON.stringify({ scripts: { test: script } }), "utf8");
    return d;
  };

  it("blocks a task when the suite is red, whatever the criteria say", async () => {
    const d = await withPkg("node -e \"process.exit(1)\"");
    // The provider would happily report every criterion met; the suite overrules it.
    const p = provider([{ criterion: "c", met: true, evidence: "looks fine" }]);
    const res = await verifyAcceptance(gdeps(p), card(["c"]), d);
    expect(res.passed).toBe(false);
    expect(res.tests).toMatchObject({ ran: true, passed: false });
    await rm(d, { recursive: true, force: true });
  });

  /**
   * A card that promised nothing used to pass trivially. That reasoning holds for criteria and not for the
   * suite: a task can break something it never mentioned.
   */
  it("blocks a task with NO criteria when the suite is red", async () => {
    const d = await withPkg("node -e \"process.exit(1)\"");
    const res = await verifyAcceptance(gdeps(provider([])), card([]), d);
    expect(res.passed).toBe(false);
    await rm(d, { recursive: true, force: true });
  });

  it("reports the failure output, so a pre-existing red suite can be told apart from a new one", async () => {
    const d = await withPkg("node -e \"console.log('FAILED: unrelated_test'); process.exit(1)\"");
    const res = await verifyAcceptance(gdeps(provider([])), card([]), d);
    expect(res.unmet[0]).toContain("FAILED: unrelated_test");
    await rm(d, { recursive: true, force: true });
  });

  it("lets a green suite through and records that it ran", async () => {
    const d = await withPkg("node -e \"process.exit(0)\"");
    const res = await verifyAcceptance(gdeps(provider([])), card([]), d);
    expect(res.passed).toBe(true);
    expect(res.tests).toMatchObject({ ran: true, passed: true });
    await rm(d, { recursive: true, force: true });
  });

  // A project that does not test has not broken anything by not testing.
  it("skips a project with no suite rather than failing it", async () => {
    const res = await verifyAcceptance(gdeps(provider([])), card([]), dir);
    expect(res.passed).toBe(true);
    expect(res.tests?.ran).toBe(false);
  });

  it("ignores npm's placeholder script", async () => {
    const d = await withPkg('echo "Error: no test specified" && exit 1');
    const res = await verifyAcceptance(gdeps(provider([])), card([]), d);
    expect(res.passed).toBe(true);
    expect(res.tests?.ran).toBe(false);
    await rm(d, { recursive: true, force: true });
  });
});
