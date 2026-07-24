import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTeamRegistry, buildCouncilRegistry, runTeam, runCouncil, runJudge, runReviewLoop,
  type ReviewDeps,
} from "../../src/engine/review.js";
import type { ReviewerConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-review-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// Content-based deterministic provider serving the three review roles by their distinct system prompt:
//  - TEAM member  → "Your perspective:" → an Assessment  (keyed by perspective substring in `assessments`)
//  - COUNCIL vote → "review COUNCIL"    → a CouncilVote   (keyed by lens substring in `councilVotes`; default pass)
//  - JUDGE        → "P-judge"           → a JudgeDecision (sequence in `judge`)
export function reviewProvider(opts: { assessments?: Record<string, string>; councilVotes?: Record<string, "pass" | "revise">; judge?: string[] }): Provider {
  let judgeCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const emit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      if (sys.includes("review COUNCIL")) {
        const key = Object.keys(opts.councilVotes ?? {}).find((k) => sys.includes(k));
        const vote = (opts.councilVotes ?? {})[key ?? ""] ?? "pass";
        yield* emit(`{"vote":"${vote}","rationale":"r"}`);
        return;
      }
      if (sys.includes("perspective")) {
        const key = Object.keys(opts.assessments ?? {}).find((k) => sys.includes(k));
        yield* emit((opts.assessments ?? {})[key ?? ""] ?? '{"concerns":[],"recommendation":"approve"}');
        return;
      }
      if (sys.includes("P-judge")) {
        const arr = opts.judge ?? ['{"decision":"pass","feedback":[],"question":""}'];
        yield* emit(arr[judgeCall] ?? arr[arr.length - 1]);
        judgeCall++;
        return;
      }
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

export const team: ReviewerConfig[] = [
  { name: "security", perspective: "security vulnerabilities", models: ["m"] },
  { name: "arch", perspective: "architectural layers", models: ["m"] },
];
// A 5-member council so a 4/5 supermajority (or a split → judge) can be exercised. Lens substrings are used
// to target individual votes in `councilVotes`.
export const council: ReviewerConfig[] = [
  { name: "c1", perspective: "correctness", models: ["m"] },
  { name: "c2", perspective: "risk", models: ["m"] },
  { name: "c3", perspective: "completeness", models: ["m"] },
  { name: "c4", perspective: "uservalue", models: ["m"] },
  { name: "c5", perspective: "feasibility", models: ["m"] },
];

export function rdeps(provider: Provider, signal?: AbortSignal): ReviewDeps {
  const roles: Record<string, RoleConfig> = { judge: { models: ["m"], systemPrompt: "P-judge" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
    teamRegistry: buildTeamRegistry(team),
    team,
    councilRegistry: buildCouncilRegistry(council),
    council,
  };
}

// council votes → { c1..c5: revise } (all revise) helper
const allRevise: Record<string, "revise"> = { correctness: "revise", risk: "revise", completeness: "revise", uservalue: "revise", feasibility: "revise" };
// a 3-2 split (2 revise, 3 pass) → no 4/5 supermajority → escalates to the judge
const splitVotes: Record<string, "pass" | "revise"> = { correctness: "revise", risk: "revise" };

describe("buildTeamRegistry / buildCouncilRegistry", () => {
  it("team member → role with the finder prompt; council member → role with the voter prompt", () => {
    const t = buildTeamRegistry(team).resolve("security");
    expect(t.model).toBe("m");
    expect(t.systemPrompt).toContain("security vulnerabilities");
    expect(t.systemPrompt).toContain("perspective");
    const c = buildCouncilRegistry(council).resolve("c1");
    expect(c.systemPrompt).toContain("review COUNCIL");
    expect(c.systemPrompt).toContain("correctness");
  });
});

describe("runTeam", () => {
  it("runs the team in parallel → named assessments; read-only toolset", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: {
        "security": '{"findings":[{"severity":"critical","note":"secret leak"},{"severity":"low","note":"nit"}],"recommendation":"revise"}',
        "architectural": '{"findings":[],"recommendation":"approve"}',
      },
    });
    const out = await runTeam(rdeps(p), dir, "spec.md");
    const byName = Object.fromEntries(out.map((a) => [a.name, a]));
    expect(byName.security.recommendation).toBe("revise");
    expect(byName.security.findings.map((f) => f.severity)).toEqual(["critical", "low"]); // severity-tagged
    expect(byName.arch.recommendation).toBe("approve");
  });

  it("streams each member's result (verdict + severity counts) onto its live row as it finishes", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: {
      "security": '{"findings":[{"severity":"critical","note":"x"},{"severity":"critical","note":"y"},{"severity":"low","note":"z"}],"recommendation":"revise"}',
      "architectural": '{"findings":[],"recommendation":"approve"}',
    } });
    const results: { id: string; status: string }[] = [];
    await runTeam(rdeps(p), dir, "spec.md", (ev) => { if (ev.kind === "agent-result") results.push(ev as never); });
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(byId["team:security"]).toBe("REJECT · C:2 M:0 L:1");
    expect(byId["team:arch"]).toBe("APPROVE · C:0 M:0 L:0");
  });

  it("emits team members as live sub-agents, then clears the panel when done", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: { "security": '{"concerns":[],"recommendation":"approve"}', "architectural": '{"concerns":[],"recommendation":"approve"}' } });
    const events: { kind: string; agents?: { title: string }[] }[] = [];
    await runTeam(rdeps(p), dir, "spec.md", (ev) => events.push(ev as never));
    const agentEvents = events.filter((e) => e.kind === "agents");
    expect(agentEvents.length).toBe(2); // one to show, one to clear
    expect(agentEvents[0].agents?.map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringContaining("team:")]));
    expect(agentEvents[1].agents).toEqual([]); // cleared on finish
  });

  it("does NOT spam the chat with each member's raw finding (chat tracks actions, not agent output)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: {
      "security": '{"concerns":["secret leak"],"recommendation":"revise"}',
      "architectural": '{"concerns":[],"recommendation":"approve"}',
    } });
    const notes: string[] = [];
    await runTeam(rdeps(p), dir, "spec.md", (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(notes).toEqual([]); // no per-member chat notes; members appear only in the live-agents panel
  });

  it("a member that never submits a valid result is DROPPED — the review does not crash", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // `security` returns invalid JSON → runStructuredRole exhausts its retries and throws; runTeam must swallow
    // that one and return the members that DID respond, instead of rejecting the whole Promise.all.
    const p = reviewProvider({ assessments: {
      "security": "I have no strong opinion",           // invalid → the member fails
      "architectural": '{"concerns":[],"recommendation":"approve"}',
    } });
    const out = await runTeam(rdeps(p), dir, "spec.md"); // must NOT throw
    expect(out.map((a) => a.name)).toEqual(["arch"]); // only the responding member survives
  });

  it("member toolset is read-only (read/grep/glob/skill; no write/shell)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const { MockProvider } = await import("../../src/providers/mock.js");
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"concerns":[],"recommendation":"approve"}' } },
       { type: "done", finishReason: "tool_calls" }],
    ]);
    const one: ReviewerConfig[] = [{ name: "solo", perspective: "genel", models: ["m"] }];
    const deps: ReviewDeps = { ...rdeps(p), teamRegistry: buildTeamRegistry(one), team: one };
    await runTeam(deps, dir, "spec.md");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });
});

describe("runCouncil", () => {
  it("each member casts a pass/revise vote with a rationale (from the team's findings)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ councilVotes: { correctness: "revise" } }); // c1 revises, rest pass
    const votes = await runCouncil(rdeps(p), dir, "spec.md", [{ name: "security", findings: [{ severity: "critical", note: "x" }], recommendation: "revise" }]);
    const byName = Object.fromEntries(votes.map((v) => [v.name, v.vote]));
    expect(byName.c1).toBe("revise");
    expect(byName.c2).toBe("pass");
    expect(votes.every((v) => v.rationale.length > 0)).toBe(true);
  });

  it("emits council members as live sub-agents then clears the panel", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const events: { kind: string; agents?: { title: string }[] }[] = [];
    await runCouncil(reviewProviderDeps(), dir, "spec.md", [], (ev) => events.push(ev as never));
    const agentEvents = events.filter((e) => e.kind === "agents");
    expect(agentEvents[0].agents?.map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringContaining("council:")]));
    expect(agentEvents.at(-1)!.agents).toEqual([]);
  });
});

// small helper: council-only deps with a default (all-pass) provider
function reviewProviderDeps(): ReviewDeps { return rdeps(reviewProvider({})); }

describe("runJudge", () => {
  it("weighs team findings + council votes → a decision", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["no tests"],"question":""}'] });
    const d = await runJudge(rdeps(p), dir, "spec.md",
      [{ name: "security", findings: [{ severity: "critical", note: "x" }], recommendation: "revise" }],
      [{ name: "c1", vote: "revise", rationale: "risky" }, { name: "c2", vote: "pass", rationale: "ok" }]);
    expect(d.decision).toBe("revise");
    expect(d.feedback).toEqual(["no tests"]);
  });

  it("judge that never submits → defaults to REVISE (does not crash the review)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ["this is prose, not a decision"] }); // invalid → judge fails all retries
    const d = await runJudge(rdeps(p), dir, "spec.md",
      [{ name: "security", findings: [{ severity: "critical", note: "x" }], recommendation: "revise" }],
      [{ name: "c1", vote: "revise", rationale: "r" }]);
    expect(d.decision).toBe("revise"); // safe conservative fallback, not a thrown error
    expect(d.feedback.length).toBeGreaterThan(0);
  });
});

describe("runReviewLoop", () => {
  const noRevise = async () => {};
  // Both team lenses recommend "revise" → 0% approve < 70% consensus → the council is convened.
  const teamSplit = { security: '{"concerns":["x"],"recommendation":"revise"}', architectural: '{"concerns":["y"],"recommendation":"revise"}' };

  it("team consensus (≥70% approve) → approved WITHOUT convening the council or judge", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // default team assessments = both approve → 100% ≥ 70% → passes; council votes (would revise) never run
    const p = reviewProvider({ councilVotes: allRevise, judge: ['{"decision":"revise","feedback":["ignored"],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("team split → council supermajority PASS → approved (judge not consulted)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, judge: ['{"decision":"revise","feedback":["ignored"],"question":""}'] }); // council all pass (default)
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("team split → council supermajority REVISE → revise(rationales) → next round council pass → approved", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // round 1: team revise + council all revise → revise; round 2: council pass → approved. Provider is stateless
    // per-request, so drive round 2 via the second team consensus? Simplest: keep council revise once via a toggle.
    let round = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const em = function* (a: string) { yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const; yield { type: "done", finishReason: "tool_calls" } as const; };
        if (sys.includes("review COUNCIL")) { yield* em(round === 0 ? '{"vote":"revise","rationale":"needs work"}' : '{"vote":"pass","rationale":"ok"}'); return; }
        if (sys.includes("perspective")) { yield* em('{"concerns":["x"],"recommendation":"revise"}'); return; }
        yield { type: "text-delta", text: "ok" } as const; yield { type: "done", finishReason: "stop" } as const;
      },
    };
    const feedbacks: string[][] = [];
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); round++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(feedbacks[0].length).toBeGreaterThan(0); // council revise rationales became the revise feedback
  });

  it("chat flow is an ACTION narrative: team discusses → hands to council → council defers to judge", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: splitVotes, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    const notes: string[] = [];
    await runReviewLoop(rdeps(p), dir, "spec.md", noRevise, async () => "x", 1, (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    const joined = notes.join("\n");
    expect(joined).toMatch(/team.*discussing/i);            // team is reviewing
    expect(joined).toMatch(/Team.*split.*council/i);        // team → council hand-off
    expect(joined).toMatch(/Council.*split.*judge/i);       // council → judge hand-off
    expect(joined).toMatch(/Judge.*approve/i);              // judge ruled
    // No per-agent output leaked into the chat (no rationales, no concern strings).
    expect(joined).not.toMatch(/rationale|secret leak|no concerns/i);
  });

  it("council SPLIT (no supermajority) → judge decides pass → approved", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: splitVotes, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0); // judge passed on the split
  });

  it("council split → judge ask-human → askUser answer lands in the revise feedback → pass", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: splitVotes, judge: ['{"decision":"ask-human","feedback":["unclear"],"question":"X or Y?"}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    let asked = "";
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async (q) => { asked = q; return "X"; }, 3);
    expect(out.approved).toBe(true);
    expect(asked).toBe("X or Y?");
    expect(feedbacks[0].some((s) => s.includes("X"))).toBe(true);
  });

  it("maxRounds exhausted → offers approve / keep-reviewing / stop; approve → approved, stop → not", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const mk = () => reviewProvider({ assessments: teamSplit, councilVotes: allRevise }); // team+council revise → never passes
    let opts: string[] | undefined;
    const ok = await runReviewLoop(rdeps(mk()), dir, "spec.md", noRevise, async (_q, o) => { opts = o?.options; return "approve"; }, 2);
    expect(opts).toEqual(["Approve as-is", "Keep reviewing (2 more rounds)", "Stop"]);
    expect(ok.approved).toBe(true);
    const stop = await runReviewLoop(rdeps(mk()), dir, "spec.md", noRevise, async () => "Stop", 2);
    expect(stop.approved).toBe(false);
    const answers = ["I don't approve", "Stop"]; let ci = 0;
    const neg = await runReviewLoop(rdeps(mk()), dir, "spec.md", noRevise, async () => answers[ci++], 2);
    expect(neg.approved).toBe(false);
    expect(ci).toBe(2);
  });

  it("'keep reviewing' runs another batch of rounds before re-escalating", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: allRevise });
    const answers = ["Keep reviewing (1 more rounds)", "Approve as-is"]; let ai = 0;
    let rounds = 0;
    const out = await runReviewLoop(
      rdeps(p), dir, "spec.md", noRevise,
      async () => answers[ai++], 1,
      (ev) => { if (ev.kind === "note" && /Reviewing the/.test(ev.text)) rounds++; },
      "English",
    );
    expect(out.approved).toBe(true);
    expect(ai).toBe(2);
    expect(rounds).toBe(2); // one review round before EACH escalation (maxRounds = 1)
  });

  it("escalation is a localized selectable choice (Turkish) with the keep-reviewing option", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const mk = () => reviewProvider({ assessments: teamSplit, councilVotes: allRevise });
    let asked = "", opts: string[] | undefined;
    const out = await runReviewLoop(rdeps(mk()), dir, "spec.md", noRevise, async (q, o) => { asked = q; opts = o?.options; return "Mevcut haliyle onayla"; }, 1, () => {}, "Turkish");
    expect(asked).toMatch(/revizyon turunda onaylanmadı/);
    expect(opts).toEqual(["Mevcut haliyle onayla", "Review'a devam et (1 tur daha)", "Durdur"]);
    expect(out.approved).toBe(true);
    const out3 = await runReviewLoop(rdeps(mk()), dir, "spec.md", noRevise, async () => "Durdur", 1, () => {}, "Turkish");
    expect(out3.approved).toBe(false);
  });

  it("throws if cancelled", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const ac = new AbortController(); ac.abort();
    const p = reviewProvider({});
    await expect(
      runReviewLoop(rdeps(p, ac.signal), dir, "spec.md", noRevise, async () => "x", 2),
    ).rejects.toThrow();
  });
});
