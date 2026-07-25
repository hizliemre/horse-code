import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTeamRegistry, buildCouncilRegistry, runTeam, runCouncil, runJudge, runReviewLoop, runCodeReview,
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
      if (sys.includes("review TEAM member")) {
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
    teams: { spec: team, plan: team, code: team },
    teamRegistries: {
      spec: buildTeamRegistry("spec", team),
      plan: buildTeamRegistry("plan", team),
      code: buildTeamRegistry("code", team),
    },
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
    const t = buildTeamRegistry("spec", team).resolve("security");
    expect(t.model).toBe("m");
    expect(t.systemPrompt).toContain("security vulnerabilities");
    expect(t.systemPrompt).toContain("SPEC stage");
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
    const out = await runTeam(rdeps(p), "spec", dir, "spec.md");
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
    await runTeam(rdeps(p), "spec", dir, "spec.md", undefined, (ev) => { if (ev.kind === "agent-result") results.push(ev as never); });
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(byId["team:security"]).toBe("REJECT · C:2 M:0 L:1");
    expect(byId["team:arch"]).toBe("APPROVE · C:0 M:0 L:0");
  });

  it("emits team members as live sub-agents, then clears the panel when done", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: { "security": '{"concerns":[],"recommendation":"approve"}', "architectural": '{"concerns":[],"recommendation":"approve"}' } });
    const events: { kind: string; agents?: { title: string }[] }[] = [];
    await runTeam(rdeps(p), "spec", dir, "spec.md", undefined, (ev) => events.push(ev as never));
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
    await runTeam(rdeps(p), "spec", dir, "spec.md", undefined, (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(notes).toEqual([]); // no per-member chat notes; members appear only in the live-agents panel
  });

  it("a member that can't review is NOT dropped — it becomes a BLOCKING critical (UNVERIFIED), fail-safe", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // `security` returns invalid JSON → runStructuredRole exhausts its retries and throws. Instead of silently
    // dropping that lens (which would let the review approve an UNVERIFIED dimension), runTeam must return a
    // blocking critical assessment for it so the council has to adjudicate the gap.
    const results: { id: string; status: string }[] = [];
    const p = reviewProvider({ assessments: {
      "security": "I have no strong opinion",           // invalid → the member fails
      "architectural": '{"findings":[],"recommendation":"approve"}',
    } });
    const out = await runTeam(rdeps(p), "spec", dir, "spec.md", undefined, (ev) => { if (ev.kind === "agent-result") results.push(ev as never); });
    expect(out.map((a) => a.name).sort()).toEqual(["arch", "security"]); // security is KEPT, not dropped
    const sec = out.find((a) => a.name === "security")!;
    expect(sec.recommendation).toBe("revise");
    expect(sec.findings).toEqual([expect.objectContaining({ severity: "critical" })]); // blocking, forces the council
    expect(results.find((r) => r.id === "team:security")!.status).toMatch(/UNVERIFIED/);
  });

  it("member toolset is read-only (read/grep/glob/skill; no write/shell)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const { MockProvider } = await import("../../src/providers/mock.js");
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"concerns":[],"recommendation":"approve"}' } },
       { type: "done", finishReason: "tool_calls" }],
    ]);
    const one: ReviewerConfig[] = [{ name: "solo", perspective: "genel", models: ["m"] }];
    const deps: ReviewDeps = { ...rdeps(p), teamRegistries: { ...rdeps(p).teamRegistries, spec: buildTeamRegistry("spec", one) }, teams: { ...rdeps(p).teams, spec: one } };
    await runTeam(deps, "spec", dir, "spec.md");
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
    const votes = await runCouncil(rdeps(p), "spec", dir, "spec.md", [{ name: "security", findings: [{ severity: "critical", note: "x" }], recommendation: "revise" }]);
    const byName = Object.fromEntries(votes.map((v) => [v.name, v.vote]));
    expect(byName.c1).toBe("revise");
    expect(byName.c2).toBe("pass");
    expect(votes.every((v) => v.rationale.length > 0)).toBe(true);
  });

  it("emits council members as live sub-agents then clears the panel", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const events: { kind: string; agents?: { title: string }[] }[] = [];
    await runCouncil(reviewProviderDeps(), "spec", dir, "spec.md", [], undefined, (ev) => events.push(ev as never));
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
    const d = await runJudge(rdeps(p), "spec", dir, "spec.md",
      [{ name: "security", findings: [{ severity: "critical", note: "x" }], recommendation: "revise" }],
      [{ name: "c1", vote: "revise", rationale: "risky" }, { name: "c2", vote: "pass", rationale: "ok" }]);
    expect(d.decision).toBe("revise");
    expect(d.feedback).toEqual(["no tests"]);
  });

  it("judge that never submits → defaults to REVISE (does not crash the review)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ["this is prose, not a decision"] }); // invalid → judge fails all retries
    const d = await runJudge(rdeps(p), "spec", dir, "spec.md",
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
  // Blocking findings: from round 2 on ONLY criticals keep the loop going, so escalation tests need these.
  const teamCritical = {
    security: '{"findings":[{"severity":"critical","note":"x"}],"recommendation":"revise"}',
    architectural: '{"findings":[{"severity":"critical","note":"y"}],"recommendation":"revise"}',
  };

  it("team consensus (≥70% approve) → approved WITHOUT convening the council or judge", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // default team assessments = both approve → 100% ≥ 70% → passes; council votes (would revise) never run
    const p = reviewProvider({ councilVotes: allRevise, judge: ['{"decision":"revise","feedback":["ignored"],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async () => { revised++; }, askUser: async () => "x", maxRounds: 3 });
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("a single CRITICAL finding blocks the team shortcut even with FULL approve → council adjudicates", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // Both lenses "approve" (2/2 = 100% ≥ 70%), but security surfaces a critical finding. Count alone would
    // shortcut-pass; the severity gate must instead convene the council (each lens is the sole authority on its
    // dimension — a majority must not wave through one lens's critical). Council here votes revise → not approved.
    const p = reviewProvider({
      assessments: {
        "security": '{"findings":[{"severity":"critical","note":"secret leak"}],"recommendation":"approve"}',
        "architectural": '{"findings":[],"recommendation":"approve"}',
      },
      councilVotes: allRevise,
    });
    const notes: string[] = [];
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => "Stop", maxRounds: 1, emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); } });
    const joined = notes.join("\n");
    expect(joined).toMatch(/1 critical/i);                 // council convened BECAUSE of the critical finding
    expect(joined).toMatch(/council/i);
    expect(joined).not.toMatch(/Team.*clean.*approved/i);  // did NOT take the clean shortcut
    expect(out.approved).toBe(false);                      // council said revise → round 1 → stop
  });

  it("team split → council supermajority PASS → approved (judge not consulted)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, judge: ['{"decision":"revise","feedback":["ignored"],"question":""}'] }); // council all pass (default)
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async () => { revised++; }, askUser: async () => "x", maxRounds: 3 });
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
        if (sys.includes("review TEAM member")) { yield* em('{"concerns":["x"],"recommendation":"revise"}'); return; }
        yield { type: "text-delta", text: "ok" } as const; yield { type: "done", finishReason: "stop" } as const;
      },
    };
    const feedbacks: string[][] = [];
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async (f) => { feedbacks.push(f); round++; }, askUser: async () => "x", maxRounds: 3 });
    expect(out.approved).toBe(true);
    expect(feedbacks[0].length).toBeGreaterThan(0); // council revise rationales became the revise feedback
  });

  it("chat flow is an ACTION narrative: team discusses → hands to council → council defers to judge", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: splitVotes, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    const notes: string[] = [];
    await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => "x", maxRounds: 1, emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); } });
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
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async () => { revised++; }, askUser: async () => "x", maxRounds: 3 });
    expect(out.approved).toBe(true);
    expect(revised).toBe(0); // judge passed on the split
  });

  it("council split → judge ask-human → askUser answer lands in the revise feedback → pass", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamSplit, councilVotes: splitVotes, judge: ['{"decision":"ask-human","feedback":["unclear"],"question":"X or Y?"}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    let asked = "";
    const out = await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async (f) => { feedbacks.push(f); }, askUser: async (q) => { asked = q; return "X"; }, maxRounds: 3 });
    expect(out.approved).toBe(true);
    expect(asked).toBe("X or Y?");
    expect(feedbacks[0].some((s) => s.includes("X"))).toBe(true);
  });

  it("maxRounds exhausted → offers approve / keep-reviewing / stop; approve → approved, stop → not", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const mk = () => reviewProvider({ assessments: teamCritical, councilVotes: allRevise }); // criticals persist → never passes
    let opts: string[] | undefined;
    const ok = await runReviewLoop(rdeps(mk()), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async (_q, o) => { opts = o?.options; return "approve"; }, maxRounds: 2 });
    expect(opts).toEqual(["Approve as-is", "Keep reviewing (2 more rounds)", "Stop"]);
    expect(ok.approved).toBe(true);
    const stop = await runReviewLoop(rdeps(mk()), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => "Stop", maxRounds: 2 });
    expect(stop.approved).toBe(false);
    const answers = ["I don't approve", "Stop"]; let ci = 0;
    const neg = await runReviewLoop(rdeps(mk()), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => answers[ci++], maxRounds: 2 });
    expect(neg.approved).toBe(false);
    expect(ci).toBe(2);
  });

  it("'keep reviewing' runs another batch of rounds before re-escalating", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: teamCritical, councilVotes: allRevise });
    const answers = ["Keep reviewing (1 more rounds)", "Approve as-is"]; let ai = 0;
    let rounds = 0;
    const out = await runReviewLoop(
      rdeps(p), {
        stage: "spec", workdir: dir, target: "spec.md", revise: noRevise,
        askUser: async () => answers[ai++], maxRounds: 1,
        emit: (ev) => { if (ev.kind === "note" && /Reviewing the/.test(ev.text)) rounds++; },
        language: "English",
      },
    );
    expect(out.approved).toBe(true);
    expect(ai).toBe(2);
    expect(rounds).toBe(2); // one review round before EACH escalation (maxRounds = 1)
  });

  it("escalation is a localized selectable choice (Turkish) with the keep-reviewing option", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const mk = () => reviewProvider({ assessments: teamSplit, councilVotes: allRevise });
    let asked = "", opts: string[] | undefined;
    const out = await runReviewLoop(rdeps(mk()), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async (q, o) => { asked = q; opts = o?.options; return "Mevcut haliyle onayla"; }, maxRounds: 1, language: "Turkish" });
    expect(asked).toMatch(/revizyon turunda onaylanmadı/);
    expect(opts).toEqual(["Mevcut haliyle onayla", "Review'a devam et (1 tur daha)", "Durdur"]);
    expect(out.approved).toBe(true);
    const out3 = await runReviewLoop(rdeps(mk()), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => "Durdur", maxRounds: 1, language: "Turkish" });
    expect(out3.approved).toBe(false);
  });

  it("throws if cancelled", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const ac = new AbortController(); ac.abort();
    const p = reviewProvider({});
    await expect(
      runReviewLoop(rdeps(p, ac.signal), { stage: "spec", workdir: dir, target: "spec.md", revise: noRevise, askUser: async () => "x", maxRounds: 2 }),
    ).rejects.toThrow();
  });
});

describe("stage-aware framing", () => {
  it("each stage's lens prompt states what the artifact IS and which questions are out of scope", () => {
    const one = [{ name: "x", perspective: "p", models: ["m"] }];
    const spec = buildTeamRegistry("spec", one).resolve("x").systemPrompt;
    expect(spec).toContain("SPECIFICATION");
    expect(spec).toMatch(/MUST NOT contain implementation detail/i);
    expect(spec).toMatch(/OUT OF SCOPE/);
    expect(spec).toMatch(/does not specify <technical mechanism>" is NOT a finding/i);

    const plan = buildTeamRegistry("plan", one).resolve("x").systemPrompt;
    expect(plan).toContain("IMPLEMENTATION PLAN");
    expect(plan).toMatch(/right place for technology and mechanism decisions/i);
    expect(plan).toMatch(/re-litigating WHAT the product should do/i);

    const code = buildTeamRegistry("code", one).resolve("x").systemPrompt;
    expect(code).toMatch(/reviewing CODE/i);
    expect(code).toMatch(/re-litigating the approved spec or plan/i);
  });

  it("every stage carries the anti-gold-plating scope rule", () => {
    for (const stage of ["spec", "plan", "code"] as const) {
      const p = buildTeamRegistry(stage, [{ name: "x", perspective: "p", models: ["m"] }]).resolve("x").systemPrompt;
      expect(p).toMatch(/Scale your expectations to the REQUESTED scope/);
      expect(p).toMatch(/scope creep/);
    }
  });

  it("the user's original request is handed to every reviewer as the scope anchor", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const seen: string[] = [];
    const p: Provider = {
      async *chat(req) {
        seen.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"findings":[],"recommendation":"approve"}' } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    await runTeam(rdeps(p), "spec", dir, "spec.md", "build a small todo app");
    expect(seen.join("\n")).toContain("build a small todo app");
  });
});

describe("runCodeReview (code stage → task-cycle verdict)", () => {
  it("clean team → pass, without convening the council", async () => {
    const p = reviewProvider({ councilVotes: allRevise }); // council would revise — it must not be asked
    const v = await runCodeReview(rdeps(p), dir, "add login endpoint");
    expect(v.verdict).toBe("pass");
    expect(v.notes).toEqual([]);
  });

  it("a blocking finding → council adjudicates; on revise the findings become the implementer's notes", async () => {
    const p = reviewProvider({
      assessments: { "security vulnerabilities": '{"findings":[{"severity":"critical","note":"unchecked input"}],"recommendation":"revise"}' },
      councilVotes: allRevise,
    });
    const v = await runCodeReview(rdeps(p), dir, "add login endpoint");
    expect(v.verdict).toBe("fail");
    expect(v.notes.some((n) => /\[critical\] security: unchecked input/.test(n))).toBe(true);
  });

  it("uses the CODE lens set (not the spec/plan ones)", async () => {
    const sys: string[] = [];
    const p: Provider = {
      async *chat(req) {
        sys.push(typeof req.messages[0]?.content === "string" ? req.messages[0].content : "");
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"findings":[],"recommendation":"approve"}' } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    await runCodeReview(rdeps(p), dir, "task title");
    expect(sys.join("\n")).toMatch(/review TEAM member for the CODE stage/);
  });
});

describe("tiered bar + convergence guard (loop termination)", () => {
  const noRevise = async () => {};
  const mediumOnly = {
    security: '{"findings":[{"severity":"medium","note":"clarify FR-3"}],"recommendation":"revise"}',
    architectural: '{"findings":[{"severity":"low","note":"wording"}],"recommendation":"revise"}',
  };

  it("round 1: a medium finding still blocks the shortcut (thorough first pass)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: mediumOnly, councilVotes: allRevise });
    let revised = 0;
    const notes: string[] = [];
    await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: async () => { revised++; }, askUser: async () => "Stop", maxRounds: 1,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(notes.join("\n")).toMatch(/1 critical \/ 1 medium|medium finding/i); // council convened in round 1
    expect(revised).toBe(1); // …and it produced a revision
  });

  it("round 2+ with only mediums: the COUNCIL decides whether to defer (not a hard rule)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // Council: revise on the round-1 (blocking) question, pass on the round-2 deferral question.
    let councilCalls = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const em = function* (a: string) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
          yield { type: "done", finishReason: "tool_calls" } as const;
        };
        if (sys.includes("review COUNCIL")) { councilCalls++; yield* em(councilCalls <= council.length ? '{"vote":"revise","rationale":"r"}' : '{"vote":"pass","rationale":"ok"}'); return; }
        if (sys.includes("review TEAM member")) {
          yield* em(sys.includes("security")
            ? '{"findings":[{"severity":"medium","note":"clarify FR-3"}],"recommendation":"revise"}'
            : '{"findings":[{"severity":"low","note":"wording"}],"recommendation":"revise"}');
          return;
        }
        yield { type: "text-delta", text: "ok" }; yield { type: "done", finishReason: "stop" };
      },
    };
    let revised = 0;
    const notes: string[] = [];
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: async () => { revised++; }, askUser: async () => "Stop", maxRounds: 5,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(out.approved).toBe(true);
    expect(revised).toBe(1); // round 1 revised; round 2 the council was ASKED and agreed to defer
    expect(notes.join("\n")).toMatch(/asking the \*\*council\*\* whether to defer/i);
    expect(notes.join("\n")).toMatch(/voted to defer/i);
    expect(out.deferred).toEqual(expect.arrayContaining([
      expect.stringContaining("[spec][medium] security: clarify FR-3"),
      expect.stringContaining("[spec][low] arch: wording"),
    ]));
  });

  it("the council may VETO a deferral once (a mislabelled medium is really blocking), then it settles", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: mediumOnly, councilVotes: allRevise }); // council always says revise
    let revised = 0;
    const notes: string[] = [];
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: async () => { revised++; }, askUser: async () => "Stop", maxRounds: 5,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(out.approved).toBe(true);
    expect(revised).toBe(2); // round 1 + the council's single deferral veto — bounded, not a loop
    expect(notes.join("\n")).toMatch(/worth fixing.*one more revision/i);
    expect(out.deferred?.length).toBeGreaterThan(0);
  });

  it("criticals that don't drop round-over-round stop the batch early (no burning rounds)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const stuck = {
      security: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
      architectural: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
    };
    const p = reviewProvider({ assessments: stuck, councilVotes: allRevise });
    let rounds = 0;
    const notes: string[] = [];
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => "Stop", maxRounds: 5,
      emit: (ev) => { if (ev.kind === "note") { const t = (ev as { text: string }).text; notes.push(t); if (/Reviewing the/.test(t)) rounds++; } },
    });
    expect(out.approved).toBe(false);
    expect(rounds).toBe(2); // round 1 revised, round 2 saw no improvement → escalated instead of 5 rounds
    expect(notes.join("\n")).toMatch(/not converging/i);
  });
});

describe("runCodeReview tiered bar (attempt-driven)", () => {
  const mediumOnlyCode = {
    security: '{"findings":[{"severity":"medium","note":"tighten validation"}],"recommendation":"revise"}',
    architectural: '{"findings":[{"severity":"low","note":"naming"}],"recommendation":"revise"}',
  };

  it("first attempt: a medium finding still fails the task (thorough first review)", async () => {
    const p = reviewProvider({ assessments: mediumOnlyCode, councilVotes: allRevise });
    const v = await runCodeReview(rdeps(p), dir, "add endpoint", undefined, () => {}, 0);
    expect(v.verdict).toBe("fail");
    expect(v.notes.some((n) => /medium.*tighten validation/i.test(n))).toBe(true);
  });

  it("a later attempt: the COUNCIL is asked whether to defer the leftover mediums (pass → no re-implementation)", async () => {
    const p = reviewProvider({ assessments: mediumOnlyCode }); // council defaults to "pass" → defer
    const notes: string[] = [];
    const v = await runCodeReview(rdeps(p), dir, "add endpoint", undefined,
      (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); }, 1);
    expect(v.verdict).toBe("pass");
    expect(notes.join("\n")).toMatch(/asking the \*\*council\*\* whether to defer/i);
    expect(notes.join("\n")).toMatch(/voted to defer/i);
    // Not dropped: they ride the Verdict to the board, and from there to the PR revision pass.
    expect(v.deferred).toEqual(expect.arrayContaining([expect.stringContaining("[code][medium] security: tighten validation")]));
  });

  it("a later attempt: the council can still say a leftover medium must be fixed now → task fails", async () => {
    const p = reviewProvider({ assessments: mediumOnlyCode, councilVotes: allRevise });
    const v = await runCodeReview(rdeps(p), dir, "add endpoint", undefined, () => {}, 1);
    expect(v.verdict).toBe("fail");
    expect(v.notes.some((n) => /tighten validation/.test(n))).toBe(true);
  });

  it("a later attempt with a CRITICAL still goes to the council and can fail", async () => {
    const p = reviewProvider({
      assessments: { security: '{"findings":[{"severity":"critical","note":"sql injection"}],"recommendation":"revise"}' },
      councilVotes: allRevise,
    });
    const v = await runCodeReview(rdeps(p), dir, "add endpoint", undefined, () => {}, 3);
    expect(v.verdict).toBe("fail");
    expect(v.notes.some((n) => /sql injection/.test(n))).toBe(true);
  });
});
