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
import { fakeSpecKit } from "../support/fake-speckit.js";

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
    specKit: fakeSpecKit,
    manager,
  };
}

const session = (d: string): WorktreeSession => ({ jobSlug: "j", root: "/x", baseWorktree: d, baseBranch: "hc/j/base" });

describe("runRevision", () => {
  /**
   * The approval is SAID on the pull request, and it did not used to be.
   *
   * `postComments` only ran when changes were requested, so a review that read the whole merged diff and
   * passed it left the pull request as silent as one that never ran — measured on PR #765, where the review
   * approved and the only threads were from the earlier rounds that had asked for changes.
   */
  it("approval on the first round → approved(0); no senior, no commit, but the pull request is told", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const mgr = fakeManager();
    const outcomes: (string | undefined)[] = [];
    const board = new Board();
    const res = await runRevision(rdeps(p, mgr), session(dir), board,
      async (_c, outcome) => { outcomes.push(outcome); }, async () => "x", 3);
    expect(res.status).toBe("approved");
    if (res.status === "approved") expect(res.rounds).toBe(0);
    expect(outcomes).toEqual(["approved"]);
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
    expect(posted[0]).toEqual(["testsiz"]);   // …the round that asked for changes
    expect(posted[1]).toEqual([]);            // …and the round that approved, which says so too
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

describe("deferred code findings reach the PR revision pass", () => {
  it("the FIRST principal review is handed the deferred list to adjudicate; later rounds are not", async () => {
    const seen: string[] = [];
    let review = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        if (!sys.includes("P-principal")) { // senior-coder revises in prose and stops
          yield { type: "text-delta", text: "revised" };
          yield { type: "done", finishReason: "stop" };
          return;
        }
        let args = '{"decision":"approve","comments":[]}';
        if (convo.includes("PR review")) {
          seen.push(convo);
          review++;
          args = review === 1 ? '{"decision":"request-changes","comments":["fix it"]}' : '{"decision":"approve","comments":[]}';
        }
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const dir2 = await mkdtemp(join(tmpdir(), "hc-rev-def-"));
    try {
      await runRevision(rdeps(p, fakeManager()), session(dir2), new Board(), async () => {}, async () => "x", 3, undefined,
        ["[code][medium] security: tighten validation"]);
      expect(seen[0]).toContain("tighten validation");            // round 1 sees the deferred findings
      expect(seen[0]).toMatch(/judge which genuinely deserve a fix/i);
      expect(seen[1] ?? "").not.toContain("tighten validation");  // later rounds react to its own comments
    } finally { await rm(dir2, { recursive: true, force: true }); }
  });
});

describe("a revision pass that changes nothing", () => {
  it("retries once, then settles instead of burning every remaining round", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "hc-rev-noop-"));
    try {
      let seniorRuns = 0, reviews = 0;
      const p: Provider = {
        async *chat(req) {
          const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
          const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
          const em = function* (a: string) {
            yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
            yield { type: "done", finishReason: "tool_calls" } as const;
          };
          if (sys.includes("P-senior-coder")) { // "fixes" it in prose only — writes nothing
            seniorRuns++;
            yield { type: "text-delta", text: "looks fine to me" };
            yield { type: "done", finishReason: "stop" };
            return;
          }
          if (convo.includes("FINAL DECISION")) { yield* em('{"decision":"accept","question":""}'); return; }
          reviews++;
          yield* em('{"decision":"request-changes","comments":["no tests"]}');
        },
      };
      // A real git worktree is required for the no-change detection to be active.
      const { initTmpRepo } = await import("../worktree/helpers.js");
      const repo = await initTmpRepo();
      try {
        const { WorktreeManager } = await import("../../src/worktree/manager.js");
        const mgr = new WorktreeManager({ repoRoot: repo });
        const s = await mgr.openSession("main", "rev");
        const res = await runRevision(rdeps(p, fakeManager()), s, new Board(), async () => {}, async () => "x", 5);
        expect(seniorRuns).toBe(2);           // one attempt + exactly one explicit retry
        expect(reviews).toBe(1);              // did NOT burn the remaining 4 principal reviews
        expect(res.status).toBe("accepted");  // settled via the final decision
      } finally { await rm(repo, { recursive: true, force: true }); }
    } finally { await rm(dir2, { recursive: true, force: true }); }
  });
});

/**
 * The revision pass keeps its own bookkeeping card, and a resumed board already has it.
 *
 * `addCard` throws on a duplicate id and the board is persisted across runs, so the SECOND run of any job
 * died at the very end — after all the work. Measured on a real run: 162 minutes, 71 tasks merged, 22
 * deferred notes ready to adjudicate, and nothing delivered because of a bookkeeping row.
 */
describe("a resumed board already has the revision card", () => {
  it("does not throw when the card is already there", async () => {
    const mgr = fakeManager();
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const board = new Board();
    board.addCard({ id: "__revision__", title: "PR revision" }); // as a resumed board carries it
    const res = await runRevision(rdeps(p, mgr), session(dir), board, async () => {}, async () => "x", 3);
    expect(res.status).toBe("approved");
  });

  /** Its history is the record of the earlier rounds — a resumed run continues them, it does not restart. */
  it("keeps the history the earlier rounds wrote", async () => {
    const mgr = fakeManager();
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const board = new Board();
    board.addCard({ id: "__revision__", title: "PR revision" });
    board.appendStage("__revision__", { role: "principal-coder", action: "revise", note: "round 1" });
    await runRevision(rdeps(p, mgr), session(dir), board, async () => {}, async () => "x", 3);
    expect(board.get("__revision__")!.stageHistory.some((h) => h.note === "round 1")).toBe(true);
  });
});

/**
 * Approving while your own objections still read as open leaves the reader to work out which ones stand.
 *
 * Measured on PR #765: two `Active` threads, every finding of the first demonstrably fixed on the branch,
 * and the review had since approved the result.
 */
describe("an approval closes the threads the review opened", () => {
  it("resolves them when it approves", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    let resolved = 0;
    await runRevision(rdeps(p, fakeManager()), session(dir), new Board(),
      async () => {}, async () => "x", 3, undefined, undefined, async () => { resolved++; });
    expect(resolved).toBe(1);
  });

  it("leaves them open when the pass ends without approving", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"request-changes","comments":["a"]}'],
      final: '{"decision":"ask-human","question":"X?"}' });
    let resolved = 0;
    const res = await runRevision(rdeps(p, fakeManager()), session(dir), new Board(),
      async () => {}, async () => "okay", 1, undefined, undefined, async () => { resolved++; });
    expect(res.status).toBe("human");
    expect(resolved).toBe(0);
  });

  /** A platform that will not resolve them is untidy, never a reason to fail a reviewed pull request. */
  it("still reports the approval when resolving fails", async () => {
    const p = revisionProvider({ reviews: ['{"decision":"approve","comments":[]}'] });
    const res = await runRevision(rdeps(p, fakeManager()), session(dir), new Board(),
      async () => {}, async () => "x", 3, undefined, undefined,
      async () => { throw new Error("TF401019"); });
    expect(res.status).toBe("approved");
  });
});

/**
 * A round the reviser could not finish must not cost a round.
 *
 * When the turn budget runs out mid-round the code says so out loud — "what it changed is kept; the next
 * review round reads the result and asks for the rest" — and that promise holds only if a revising round is
 * still left. The LAST round never revises: it asks the principal for a final verdict and, failing that, puts
 * the unfinished findings to the user.
 *
 * Reported live: nine comments exhausted a 72-turn budget in round 1, and the run then spent its remaining
 * rounds and asked the user whether to accept the risks — for findings its own reviser had never been given
 * the chance to finish.
 */
describe("what an unfinished revision round costs", () => {
  const src = async (): Promise<string> => (await import("node:fs/promises")).readFile("src/engine/revision.ts", "utf8");

  it("reports whether the reviser finished, rather than swallowing it", async () => {
    const s = await src();
    expect(s).toContain("async function seniorRevise(deps: RevisionDeps, base: string, comments: string[]): Promise<RevisionAccount>");
    // Out of turns → ok:false, and the run buys a round back for it.
    expect(s).toContain("return { ok: false, said: spoken.join(\"\\n\\n\").trim() };   // …and that next round has to exist");
  });

  it("buys one more round when a round was cut short", async () => {
    const s = await src();
    expect(s).toContain("const account = await seniorRevise(deps, base, v.comments);");
    expect(s).toContain("if (!account.ok && rounds + extra < cap) extra++;");
    expect(s).toContain("for (let round = 1; round <= rounds + extra; round++)");
    // …and the final-verdict branch moves with it, or the extra round would never revise either.
    expect(s).toContain("if (round === rounds + extra) {");
  });

  /** Bounded, or a reviser that never converges would never stop. */
  it("still ends", async () => {
    const s = await src();
    expect(s).toContain("const cap = rounds * 2;");
  });

  /** The user is told the real budget, not the one it started with. */
  it("counts the rounds it will actually run", async () => {
    const s = await src();
    expect(s).toContain("round ${round}/${rounds + extra}");
  });
});
