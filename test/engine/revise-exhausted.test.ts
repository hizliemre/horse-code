import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRevision, reviseTurnBudget, type RevisionDeps } from "../../src/engine/revision.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";
import { Board } from "../../src/board/board.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-rex-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A reviser that never stops writing, so it always reaches the ceiling — with real work done on the way. */
function endlessReviser(reviews: string[]): Provider {
  let n = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      if (sys.includes("P-principal")) {
        const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        const body = convo.includes("FINAL DECISION")
          ? '{"decision":"accept","question":""}'
          : (reviews[Math.min(n++, reviews.length - 1)]);
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: body } };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      // …the senior: one more file, forever.
      yield { type: "tool-call", toolCall: { id: `w${n++}`, name: "write_file",
        arguments: JSON.stringify({ path: `fix-${n}.txt`, content: "partial" }) } };
      yield { type: "done", finishReason: "tool_calls" };
    },
  };
}

function rdeps(provider: Provider, manager: RevisionDeps["manager"]): RevisionDeps {
  const roles: Record<string, RoleConfig> = {
    "principal-coder": { models: ["m"], systemPrompt: "P-principal" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
    manager,
  };
}
const session = (d: string): WorktreeSession => ({ jobSlug: "j", root: "/x", baseWorktree: d, baseBranch: "hc/j/base" });
function fakeManager() {
  return { commits: 0, pushes: 0, async commitMerge() { this.commits++; }, async push() { this.pushes++; } };
}

/**
 * A reviser that spends its whole budget has done work, not failed.
 *
 * Measured on a 577-minute run: five substantial review comments, `reviseTurnBudget(5) === 40`, and exactly
 * 40 model calls before the ceiling. By then the reviser had reverted the unexplained dependency churn and
 * hardened the length guard the review asked about. Rethrowing discarded all of it — the round never
 * committed, the pass never reached round 2, nothing was asked of the human, and the run just ended with the
 * edits left uncommitted in the base worktree.
 */
describe("a reviser that runs out of turns", () => {
  it("does not end the revision pass", async () => {
    const mgr = fakeManager();
    const notes: string[] = [];
    const deps = { ...rdeps(endlessReviser(['{"decision":"request-changes","comments":["a","b"]}']), mgr),
      note: (t: string) => { notes.push(t); } };
    const res = await runRevision(deps, session(dir), new Board(), async () => {}, async () => "ok", 2);
    expect(res.status).not.toBe(undefined);          // …it returned rather than throwing
    expect(mgr.commits).toBeGreaterThan(0);          // …and the partial work was committed
    expect(mgr.pushes).toBeGreaterThan(0);           // …and pushed, so the pull request has it
    expect((await readdir(dir)).some((f) => f.startsWith("fix-"))).toBe(true);
  });

  it("says the budget was spent, and does not claim more than it did", async () => {
    const notes: string[] = [];
    const deps = { ...rdeps(endlessReviser(['{"decision":"request-changes","comments":["a"]}']), fakeManager()),
      note: (t: string) => { notes.push(t); } };
    await runRevision(deps, session(dir), new Board(), async () => {}, async () => "ok", 2);
    const spent = notes.find((n) => /turn budget/i.test(n));
    expect(spent).toBeDefined();
    expect(spent).toMatch(/next review round/i);     // …the rounds are what recover the rest
  });

  /** The board must show the round happened, or a finished run looks like one that never revised. */
  it("still records the round on the revision card", async () => {
    const board = new Board();
    const deps = { ...rdeps(endlessReviser(['{"decision":"request-changes","comments":["a"]}']), fakeManager()),
      note: () => {} };
    await runRevision(deps, session(dir), board, async () => {}, async () => "ok", 2);
    const history = board.get("__revision__")?.stageHistory ?? [];
    expect(history.some((h) => h.action === "pr:revised")).toBe(true);
  });

  it("keeps the budget itself proportional to the work", () => {
    expect(reviseTurnBudget(5)).toBe(40);
    expect(reviseTurnBudget(1)).toBe(30);   // …the floor covers the one comment that turns out to be hard
  });
});
