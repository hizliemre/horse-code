import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRevision, type RevisionDeps } from "../../src/engine/revision.js";
import type { WorktreeSession } from "../../src/worktree/manager.js";
import { Board } from "../../src/board/board.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-rev-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// principal (review vs "FINAL DECISION" final) + senior (write→done) content-provider.
function revisionProvider(opts: { reviews: string[]; final?: string }): Provider {
  let reviewCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const submit = function* (a: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const call = function* (name: string, a: string) {
        yield { type: "tool-call", toolCall: { id: "t", name, arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const stop = function* (t: string) {
        yield { type: "text-delta", text: t } as const;
        yield { type: "done", finishReason: "stop" } as const;
      };
      if (sys.includes("P-principal")) {
        if (convo.includes("FINAL DECISION")) { yield* submit(opts.final ?? '{"decision":"accept","question":""}'); return; }
        yield* submit(opts.reviews[reviewCall] ?? opts.reviews[opts.reviews.length - 1]);
        reviewCall++;
        return;
      }
      if (sys.includes("P-senior-coder")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "fix.txt", content: "fix" })); return; }
        yield* stop("done"); return;
      }
      yield* stop("ok");
    },
  };
}

function fakeManager() {
  return { commits: 0, pushes: 0, async commitMerge() { this.commits++; }, async push() { this.pushes++; } };
}

function rdeps(provider: Provider, manager: RevisionDeps["manager"], signal?: AbortSignal): RevisionDeps {
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
    signal: signal ?? new AbortController().signal,
    manager,
  };
}

const session = (d: string): WorktreeSession => ({ jobSlug: "j", root: "/x", baseWorktree: d, baseBranch: "hc/j/base" });

describe("runRevision", () => {
  it("approval on the first round → approved(0); senior/postComments/commit not called", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const mgr = fakeManager();
    let posted = 0;
    const board = new Board();
    const res = await runRevision(rdeps(p, mgr), session(dir), board, async () => { posted++; }, async () => "x", 3);
    expect(res.status).toBe("approved");
    if (res.status === "approved") expect(res.rounds).toBe(0);
    expect(posted).toBe(0);
    expect(mgr.commits).toBe(0);
    expect(board.get("__revision__")!.stageHistory.some((s) => s.action === "pr:approved")).toBe(true);
  });

  it("one revision → approval: postComments + senior writes + commit/push; approved(1)", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["testsiz"]}', '{"decision":"approve","comments":[]}'] });
    const mgr = fakeManager();
    const posted: string[][] = [];
    const res = await runRevision(rdeps(p, mgr), session(dir), new Board(), async (c) => { posted.push(c); }, async () => "x", 3);
    expect(res.status).toBe("approved");
    if (res.status === "approved") expect(res.rounds).toBe(1);
    expect(posted).toEqual([["testsiz"]]);
    expect(mgr.commits).toBe(1);
    expect(mgr.pushes).toBe(1);
    expect(existsSync(join(dir, "fix.txt"))).toBe(true);
  });

  it("maxRounds → accept: final decision accepted", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["a"]}'], final: '{"decision":"accept","question":""}' });
    const mgr = fakeManager();
    const res = await runRevision(rdeps(p, mgr), session(dir), new Board(), async () => {}, async () => "x", 2);
    expect(res.status).toBe("accepted");
    if (res.status === "accepted") expect(res.rounds).toBe(2);
    expect(mgr.commits).toBe(1); // only revised on round1 (round2 is the final decision)
  });

  it("maxRounds → ask a human: askUser is called, answer is returned", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["a"]}'], final: '{"decision":"ask-human","question":"X or Y?"}' });
    let asked = "";
    const res = await runRevision(rdeps(p, fakeManager()), session(dir), new Board(), async () => {}, async (q) => { asked = q; return "okay"; }, 1);
    expect(res.status).toBe("human");
    if (res.status === "human") { expect(res.answer).toBe("okay"); expect(res.rounds).toBe(1); }
    expect(asked).toBe("X or Y?");
  });

  it("when prDiff is given, the principal review request includes the diff", async () => {
    // simple provider that captures requests
    const requests: import("../../src/core/types.js").ChatRequest[] = [];
    const p: import("../../src/core/types.js").Provider = {
      async *chat(req) {
        requests.push(req);
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("P-principal")) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"decision":"approve","comments":[]}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await runRevision(rdeps(p, fakeManager()), session(dir), new Board(), async () => {}, async () => "x", 1, "DIFF-XYZ-123");
    const principalReq = requests.find((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes("DIFF-XYZ-123")));
    expect(principalReq).toBeDefined();
  });

  it("rethrows if aborted", async () => {
    const ac = new AbortController(); ac.abort();
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    await expect(
      runRevision(rdeps(p, fakeManager(), ac.signal), session(dir), new Board(), async () => {}, async () => "x", 3),
    ).rejects.toThrow();
  });
});
