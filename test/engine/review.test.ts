import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTeamRegistry, buildCouncilRegistry, runTeam, runCouncil, runJudge, runReviewLoop, runCodeReview,
  REVIEW_MAX_TURNS, changedLines, lensesFor, CORE_CODE_LENSES, SMALL_CHANGE_LINES,
  type ReviewDeps,
} from "../../src/engine/review.js";
import type { ReviewerConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";
import { CODE_TEAM } from "../../src/prompts.js";
import type { MemoryEntry } from "../../src/engine/memory-retrieval.js";
import type { MemoryEvent } from "../../src/engine/memory-inject.js";

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

  // A decider's rationale is a VERDICT; a lens finding is the DEFECT. Sending only the verdicts left the author
  // to guess at the defect, so the same finding survived the rewrite and the loop stalled on "not converging".
  it("the revision brief carries the team's DEFECTS, not just the council's verdicts", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: {
        security: '{"findings":[{"severity":"critical","note":"no CSRF token on the mutation endpoints"}],"recommendation":"revise"}',
        architectural: '{"findings":[{"severity":"medium","note":"the module boundary is not stated"}],"recommendation":"revise"}',
      },
      councilVotes: allRevise,
    });
    const briefs: string[][] = [];
    await runReviewLoop(rdeps(p), { stage: "spec", workdir: dir, target: "spec.md", revise: async (f) => { briefs.push(f); }, askUser: async () => "Stop", maxRounds: 1 });
    const brief = briefs[0];
    // The concrete defect, with its severity and the lens that raised it…
    expect(brief.some((l) => l.includes("no CSRF token") && l.includes("[critical]") && l.includes("security"))).toBe(true);
    // …the round-1 medium too (the tiered bar counts it as blocking on the first pass)…
    expect(brief.some((l) => l.includes("the module boundary") && l.includes("[medium]"))).toBe(true);
    // …and the deciders' reasons, labelled and attributed, AFTER the defects.
    expect(brief.some((l) => l.startsWith("[decision]") && l.includes("c1:"))).toBe(true);
    expect(brief.findIndex((l) => l.startsWith("[decision]"))).toBeGreaterThan(brief.findIndex((l) => l.includes("[critical]")));
  });

  it("from round 2 on, the brief carries only the CRITICAL defects (same tiered bar the round is judged by)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // The critical CHANGES between passes, so the convergence guard sees progress and a second round runs.
    let securityPass = 0;
    const evolving: Provider = {
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const emit = function* (a: string) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
          yield { type: "done", finishReason: "tool_calls" } as const;
        };
        if (sys.includes("review TEAM member")) {
          if (sys.includes("security vulnerabilities")) {
            securityPass++;
            const note = securityPass === 1 ? "missing auth check" : "missing rate limit";
            yield* emit(`{"findings":[{"severity":"critical","note":"${note}"}],"recommendation":"revise"}`);
            return;
          }
          yield* emit('{"findings":[{"severity":"medium","note":"naming could be clearer"}],"recommendation":"revise"}');
          return;
        }
        yield* reviewProvider({ councilVotes: allRevise }).chat(req, signal);
      },
    };
    const briefs: string[][] = [];
    await runReviewLoop(rdeps(evolving), { stage: "spec", workdir: dir, target: "spec.md", revise: async (f) => { briefs.push(f); }, askUser: async () => "Stop", maxRounds: 2 });
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    expect(briefs[0].some((l) => l.includes("naming could be clearer"))).toBe(true);  // round 1 weighs medium
    expect(briefs[1].some((l) => l.includes("missing rate limit"))).toBe(true);
    expect(briefs[1].some((l) => l.includes("naming could be clearer"))).toBe(false); // round 2+ does not
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
      judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'], // the judge is the last authority — only its ask-human reaches the user
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
    const mk = () => reviewProvider({ assessments: teamCritical, councilVotes: allRevise, judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'] }); // judge defers to the user
    let opts: (string | { label: string })[] | undefined;
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
    const p = reviewProvider({ assessments: teamCritical, councilVotes: allRevise, judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'] });
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
    const mk = () => reviewProvider({ assessments: teamCritical, councilVotes: allRevise, judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'] });
    let asked = "", opts: (string | { label: string })[] | undefined;
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

  it("the SAME blocking findings surviving a revision → stops revising and hands the JUDGE the final ruling", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const stuck = {
      security: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
      architectural: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
    };
    const p = reviewProvider({ assessments: stuck, councilVotes: allRevise }); // judge defaults to "pass"
    let rounds = 0;
    const notes: string[] = [];
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => "Stop", maxRounds: 5,
      emit: (ev) => { if (ev.kind === "note") { const t = (ev as { text: string }).text; notes.push(t); if (/Reviewing the/.test(t)) rounds++; } },
    });
    expect(rounds).toBe(2); // round 1 revised, round 2 saw the identical findings → stopped (not 5 rounds)
    expect(notes.join("\n")).toMatch(/not converging/i);
    // …and the JUDGE ruled — the user was never asked.
    expect(notes.join("\n")).toMatch(/Judge\*\* ruled the spec good enough/i);
    expect(out.approved).toBe(true);
  });

  it("a CHANGED set of blocking findings is progress — the loop keeps going", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    let call = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const em = function* (a: string) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
          yield { type: "done", finishReason: "tool_calls" } as const;
        };
        if (sys.includes("review COUNCIL")) { yield* em('{"vote":"revise","rationale":"r"}'); return; }
        if (sys.includes("review TEAM member")) { call++; yield* em(`{"findings":[{"severity":"critical","note":"issue-${call}"}],"recommendation":"revise"}`); return; }
        yield* em('{"decision":"pass","feedback":[],"question":""}');
      },
    };
    let rounds = 0;
    await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => "Stop", maxRounds: 3,
      emit: (ev) => { if (ev.kind === "note" && /Reviewing the/.test((ev as { text: string }).text)) rounds++; },
    });
    expect(rounds).toBe(3); // every round surfaced NEW findings → never flagged as stuck, full batch ran
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

describe("authority ladder: team → council → judge → (only then) human", () => {
  const noRevise = async () => {};
  const stuckCritical = {
    security: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
    architectural: '{"findings":[{"severity":"critical","note":"still broken"}],"recommendation":"revise"}',
  };

  it("a stuck review is ruled by the JUDGE — the user is never asked when the judge can decide", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: stuckCritical, councilVotes: allRevise }); // judge → pass
    let asked = 0;
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => { asked++; return "Stop"; }, maxRounds: 3,
    });
    expect(out.approved).toBe(true);
    expect(asked).toBe(0); // autonomous: the judge settled it
  });

  it("the judge may grant ONE more targeted batch before anyone gives up", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // judge: "revise" on the first final ruling, "pass" on the second → exactly one extra batch.
    const p = reviewProvider({
      assessments: stuckCritical, councilVotes: allRevise,
      judge: ['{"decision":"revise","feedback":["fix the root cause"],"question":""}', '{"decision":"pass","feedback":[],"question":""}'],
    });
    const notes: string[] = [];
    let asked = 0;
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => { asked++; return "Stop"; }, maxRounds: 1,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(notes.join("\n")).toMatch(/one more targeted attempt is worth it/i);
    expect(out.approved).toBe(true);
    expect(asked).toBe(0);
  });

  it("only the judge's own ask-human reaches the user", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: stuckCritical, councilVotes: allRevise,
      judge: ['{"decision":"ask-human","feedback":[],"question":"Ship without offline support?"}'],
    });
    let asked: string[] = [];
    const out = await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async (q) => { asked.push(q); return "Stop"; }, maxRounds: 1,
    });
    expect(asked.join("\n")).toMatch(/revision rounds|Ship without offline/i); // the user WAS involved
    expect(out.approved).toBe(false);
  });
});

describe("missing artifact guard", () => {
  it("never reviews a document that does not exist — fails immediately instead of burning the budget", async () => {
    // No spec.md written at all (the authoring phase produced nothing).
    const p = reviewProvider({});
    const notes: string[] = [];
    let teamRan = 0;
    const spy: Provider = {
      async *chat(req) { teamRan++; yield* p.chat(req, new AbortController().signal); },
    };
    const out = await runReviewLoop(rdeps(spy), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: async () => {}, askUser: async () => "Stop", maxRounds: 5,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(out.approved).toBe(false);
    expect(teamRan).toBe(0); // not a single lens was spent on a missing file
    expect(notes.join("\n")).toMatch(/not found/i);
    expect(notes.join("\n")).toMatch(/produced no file/i);
  });
});

describe("only the rejecting lenses re-review", () => {
  const noRevise = async () => {};

  it("a lens that approved is not re-run next round; its verdict is carried", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // security keeps rejecting; arch approves once and must never be asked again.
    let archRuns = 0, secRuns = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const em = function* (a: string) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
          yield { type: "done", finishReason: "tool_calls" } as const;
        };
        if (sys.includes("review COUNCIL")) { yield* em('{"vote":"revise","rationale":"r"}'); return; }
        if (sys.includes("review TEAM member")) {
          if (sys.includes("architectural")) { archRuns++; yield* em('{"findings":[],"recommendation":"approve"}'); return; }
          secRuns++;
          yield* em('{"findings":[{"severity":"critical","note":`still broken ${secRuns}`}],"recommendation":"revise"}'.replace("`still broken ${secRuns}`", `"still broken ${secRuns}"`));
          return;
        }
        yield* em('{"decision":"pass","feedback":[],"question":""}');
      },
    };
    const notes: string[] = [];
    await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => "Stop", maxRounds: 3,
      emit: (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); },
    });
    expect(archRuns).toBe(1);                 // approved in round 1 → never re-asked
    expect(secRuns).toBeGreaterThan(1);       // it kept rejecting → it kept reviewing
    expect(notes.join("\n")).toMatch(/approved last round — carrying their verdict/i);
  });

  it("a clean sweep that the council still rejects re-reviews in FULL (the team's read was wrong)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    let teamRuns = 0;
    const p: Provider = {
      async *chat(req) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const em = function* (a: string) {
          yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
          yield { type: "done", finishReason: "tool_calls" } as const;
        };
        if (sys.includes("review COUNCIL")) { yield* em('{"vote":"revise","rationale":"r"}'); return; }
        if (sys.includes("review TEAM member")) { teamRuns++; yield* em('{"findings":[{"severity":"medium","note":"m"}],"recommendation":"approve"}'); return; }
        yield* em('{"decision":"pass","feedback":[],"question":""}');
      },
    };
    await runReviewLoop(rdeps(p), {
      stage: "spec", workdir: dir, target: "spec.md",
      revise: noRevise, askUser: async () => "Stop", maxRounds: 2,
    });
    expect(teamRuns).toBeGreaterThanOrEqual(4); // 2 lenses × ≥2 rounds — nothing was carried
  });
});

// ── Memory reaches the review agents ──────────────────────────────────────────────────────────────────────
// Rules already rode every system prompt; facts and lessons did not, so the fifteen lenses that do the actual
// finding had no access to what earlier runs learned and kept re-discovering the same things.
describe("role-targeted memory for review agents", () => {
  const memEntry = (over: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry =>
    ({ anchors: [], tags: [], createdAt: 0, ...over });

  /** Captures every user-role message body the provider was asked to answer. */
  function recording(base: Provider): { provider: Provider; bodies: string[] } {
    const bodies: string[] = [];
    return {
      bodies,
      provider: {
        async *chat(req, signal) {
          for (const m of req.messages) if (m.role === "user" && typeof m.content === "string") bodies.push(m.content);
          yield* base.chat(req, signal);
        },
      },
    };
  }

  const withMemory = (d: ReviewDeps, entries: MemoryEntry[], events: MemoryEvent[] = []): ReviewDeps =>
    ({ ...d, memory: () => entries, onMemory: (ev: MemoryEvent) => { events.push(ev); } });

  it("a lens receives a lesson addressed to it by name", async () => {
    const { provider, bodies } = recording(reviewProvider({}));
    const entries = [memEntry({ id: "s", text: "csrf checks belong in src/mw.ts", anchors: ["src/mw.ts"], tags: ["csrf"], audience: ["security"] })];
    await runTeam(withMemory(rdeps(provider), entries), "code", dir, "src/mw.ts changes");
    expect(bodies.some((b) => b.includes("csrf checks belong in"))).toBe(true);
  });

  // With fifteen lenses, an unscoped pool means every lens pays for every other lens's context.
  it("a lens does NOT receive another lens's memory", async () => {
    const { provider, bodies } = recording(reviewProvider({}));
    const entries = [memEntry({ id: "s", text: "csrf checks belong in src/mw.ts", anchors: ["src/mw.ts"], tags: ["csrf"], audience: ["security"] })];
    await runTeam(withMemory(rdeps(provider), entries), "code", dir, "src/mw.ts changes");
    // "arch" ran too; its prompt must not carry the security lens's lesson.
    const archBodies = bodies.filter((b) => !b.includes("<memory"));
    expect(archBodies.length).toBeGreaterThan(0);
    expect(bodies.filter((b) => b.includes("csrf checks belong in"))).toHaveLength(1);
  });

  it("the team reports memory ONCE, not once per lens", async () => {
    const events: MemoryEvent[] = [];
    const entries = [memEntry({ id: "s", text: "src/mw.ts is generated — never edit it by hand", anchors: ["src/mw.ts"], tags: ["generated"] })];
    await runTeam(withMemory(rdeps(reviewProvider({})), entries, events), "code", dir, "src/mw.ts changes");
    const injected = events.filter((e) => e.kind === "injected");
    expect(injected).toHaveLength(1);
    if (injected[0].kind === "injected") expect(injected[0].role).toBe("team:code");
  });

  it("the council gets memory too, under its own label", async () => {
    const events: MemoryEvent[] = [];
    const entries = [memEntry({ id: "s", text: "src/mw.ts is generated — never edit it by hand", anchors: ["src/mw.ts"], tags: ["generated"] })];
    await runCouncil(withMemory(rdeps(reviewProvider({})), entries, events), "code", dir, "src/mw.ts changes", []);
    const injected = events.filter((e) => e.kind === "injected");
    expect(injected).toHaveLength(1);
    if (injected[0].kind === "injected") expect(injected[0].role).toBe("council");
  });

  it("memory stays fenced as DATA even inside a review prompt", async () => {
    const { provider, bodies } = recording(reviewProvider({}));
    const entries = [memEntry({ id: "s", text: "src/mw.ts is generated", anchors: ["src/mw.ts"], tags: ["generated"] })];
    await runTeam(withMemory(rdeps(provider), entries), "code", dir, "src/mw.ts changes");
    const hint = bodies.find((b) => b.includes("<memory"));
    expect(hint).toContain('<memory id="s">');
    expect(hint).toMatch(/not instructions/i);
  });

  it("runs exactly as before when no memory is wired", async () => {
    const r = await runTeam(rdeps(reviewProvider({})), "code", dir, "target");
    expect(r.map((a) => a.name).sort()).toEqual(["arch", "security"]);
  });
});

// ── Review agents propose; they never write ───────────────────────────────────────────────────────────────
// They read more of the project than anyone else, but they are narrow single-angle finders on cheaper model
// tiers — exactly the agents whose unsupervised writes would poison the store.
describe("review agents have a voice, not a pen", () => {
  const toolNames = async (run: (d: ReviewDeps) => Promise<unknown>): Promise<string[]> => {
    let names: string[] = [];
    const provider: Provider = {
      async *chat(req, signal) {
        if (!names.length) names = req.tools.map((t) => t.name);
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    await run(rdeps(provider));
    return names;
  };

  it("a lens can propose but cannot remember, write, edit or run commands", async () => {
    const names = await toolNames((d) => runTeam(d, "code", dir, "target"));
    expect(names).toContain("propose_memory");
    expect(names).not.toContain("remember_fact");
    for (const forbidden of ["write_file", "edit_file", "shell"]) expect(names).not.toContain(forbidden);
  });

  it("so can the council and the judge", async () => {
    expect(await toolNames((d) => runCouncil(d, "code", dir, "target", []))).toContain("propose_memory");
    expect(await toolNames((d) => runJudge(d, "code", dir, "target", [], []))).toContain("propose_memory");
  });

  it("a proposal is tagged with the lens that made it", async () => {
    const queued: { text: string; role: string }[] = [];
    const provider: Provider = {
      async *chat(req, signal) {
        // The security lens proposes before submitting its assessment.
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("security vulnerabilities") && !req.messages.some((m) => m.role === "tool")) {
          yield { type: "tool-call", toolCall: { id: "p", name: "propose_memory", arguments: '{"text":"secrets are loaded from .env only","kind":"fact"}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    const d: ReviewDeps = {
      ...rdeps(provider),
      proposeMemory: (text, _kind, role) => { queued.push({ text, role }); return true; },
    };
    await runTeam(d, "code", dir, "target");
    expect(queued).toEqual([{ text: "secrets are loaded from .env only", role: "security" }]);
  });

  // The load-bearing guarantee: a proposal reaches a queue, never the store.
  it("proposing never writes a memory", async () => {
    const written: string[] = [];
    const provider: Provider = {
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("security vulnerabilities") && !req.messages.some((m) => m.role === "tool")) {
          yield { type: "tool-call", toolCall: { id: "p", name: "propose_memory", arguments: '{"text":"a claim"}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    const d: ReviewDeps = {
      ...rdeps(provider),
      proposeMemory: () => true,
      rememberFact: (f) => written.push(f),
      learnMemory: async (t) => { written.push(t); return true; },
    };
    await runTeam(d, "code", dir, "target");
    expect(written).toEqual([]);
  });
});

// The team runs in parallel, so a round lasts as long as its SLOWEST member. Observed in the wild: three
// lenses finished in 2-8 minutes while four sat at 17.5 minutes with no way out.
describe("a stuck reviewer cannot hold the round hostage", () => {
  it("a lens that never returns is reported as timed out and blocks with a critical finding", async () => {
    const hang: Provider = {
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("security vulnerabilities")) {
          // Never answers; only an abort ends it — exactly what a stuck model looks like.
          await new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        }
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    const statuses: string[] = [];
    const out = await runTeam({ ...rdeps(hang), reviewTimeoutMs: 300 }, "code", dir, "target", undefined, (ev) => {
      if (ev.kind === "agent-result") statuses.push(ev.status);
    });
    const stuck = out.find((a) => a.name === "security")!;
    expect(stuck.recommendation).toBe("revise"); // fail-safe: an unchecked dimension never passes silently
    expect(stuck.findings[0].severity).toBe("critical");
    expect(stuck.findings[0].note).toMatch(/did not finish within its .*budget/);
    expect(statuses).toContain("⚠ UNVERIFIED (timed out)");
    // The healthy lens still reported — it was not dragged down with the stuck one.
    expect(out.find((a) => a.name === "arch")?.recommendation).toBe("approve");
  }, 20_000);

  it("a genuine job cancellation still propagates (it is not swallowed as a timeout)", async () => {
    const ac = new AbortController();
    const hang: Provider = {
      async *chat(req, signal) {
        ac.abort();
        await new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        yield { type: "done", finishReason: "stop" };
      },
    };
    await expect(runTeam(rdeps(hang, ac.signal), "code", dir, "target")).rejects.toThrow();
  });

  it("reviewers get a bounded tool budget — an exploring lens stops well short of the 50-turn default", async () => {
    let securityCalls = 0;
    // A lens that would happily grep forever. Without a budget it runs to the 50-turn default on every one of
    // the chain's passes; with one it stops early and is asked to submit what it has.
    const looping: Provider = {
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("security vulnerabilities")) {
          securityCalls++;
          const nudged = req.messages.some((m) => typeof m.content === "string" && /entire tool-call budget/i.test(m.content));
          if (nudged) { yield* reviewProvider({}).chat(req, signal); return; } // gives up and submits
          yield { type: "tool-call", toolCall: { id: `t${securityCalls}`, name: "grep", arguments: '{"pattern":"x"}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    const out = await runTeam(rdeps(looping), "code", dir, "target");
    expect(securityCalls).toBeLessThanOrEqual(REVIEW_MAX_TURNS + 2); // the budget, plus the submit nudge
    // …and it still produced a real assessment rather than being written off as unverified.
    expect(out.find((a) => a.name === "security")?.findings.some((f) => /UNVERIFIED/.test(f.note))).toBe(false);
  }, 30_000);
});

describe("live per-agent metering", () => {
  it("each reviewer streams its running token total while it works, not only when it finishes", async () => {
    // Two calls per lens: the first burns tokens without submitting, the second submits.
    const twoCalls: Provider = {
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("security vulnerabilities") && !req.messages.some((m) => m.role === "tool")) {
          yield { type: "usage", promptTokens: 5000, completionTokens: 400 };
          yield { type: "tool-call", toolCall: { id: "g", name: "grep", arguments: '{"pattern":"x"}' } };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "usage", promptTokens: 6000, completionTokens: 200 };
        yield* reviewProvider({}).chat(req, signal);
      },
    };
    const usage: { id: string; promptTokens: number }[] = [];
    let sawUsageBeforeResult = false;
    await runTeam(rdeps(twoCalls), "code", dir, "target", undefined, (ev) => {
      if (ev.kind === "agent-usage" && ev.id === "team:security") { usage.push(ev); sawUsageBeforeResult = true; }
      if (ev.kind === "agent-result" && ev.id === "team:security" && !sawUsageBeforeResult) throw new Error("result arrived with no live usage");
    });
    expect(usage.length).toBeGreaterThanOrEqual(2); // one per LLM call, while it was still running
    // The figure is CUMULATIVE — the row shows a total, not the last call's delta.
    expect(usage[0].promptTokens).toBe(5000);
    expect(usage[1].promptTokens).toBe(11000);
  });
});

// A fully spent chain used to be terminal for the session: the role reported "no response" on every later
// round while the same dead model sat in other roles' chains waiting to fail them the same way.
describe("a reviewer whose whole chain dies heals and retries", () => {
  const dying = (deadModels: string[]): Provider => ({
    async *chat(req, signal) {
      if (deadModels.includes(req.model)) {
        yield { type: "error", message: "429 quota exceeded", retryable: true };
        return;
      }
      yield* reviewProvider({}).chat(req, signal);
    },
  });

  it("retries on the replacement chain and produces a real assessment instead of an UNVERIFIED hole", async () => {
    const d = rdeps(dying(["m"])); // every lens is configured on "m", which is dead
    const notes: string[] = [];
    const out = await runTeam({ ...d, rechainRole: async () => ["healthy-1", "healthy-2"] },
      "code", dir, "target", undefined, (ev) => { if (ev.kind === "note") notes.push(ev.text); });
    expect(out.every((a) => a.findings.every((f) => !/UNVERIFIED/.test(f.note)))).toBe(true);
    expect(notes.join("\n")).toMatch(/lost its whole model chain/);
  });

  it("passes the REAL failure reason to the healer, not a generic message", async () => {
    const reasons: string[] = [];
    const d = rdeps(dying(["m"]));
    await runTeam({ ...d, rechainRole: async (_r, reason) => { reasons.push(reason); return ["healthy-1"]; } }, "code", dir, "target");
    expect(reasons.every((r) => /429 quota exceeded/.test(r))).toBe(true);
  });

  // "the model chain failed" and "the model was slow" have different fixes; quarantining a working-but-slow
  // model would throw away capacity over a latency problem.
  it("does NOT heal on a timeout — the model was reachable, only slow", async () => {
    let healed = 0;
    const hang: Provider = {
      async *chat(_req, signal) {
        await new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        yield { type: "done", finishReason: "stop" };
      },
    };
    const out = await runTeam({ ...rdeps(hang), reviewTimeoutMs: 200, rechainRole: async () => { healed++; return ["x"]; } },
      "code", dir, "target");
    expect(healed).toBe(0);
    expect(out[0].findings[0].note).toMatch(/did not finish within/);
  }, 20_000);

  it("when nothing healthy is left, it reports the REAL reason rather than a bare 'no response'", async () => {
    const out = await runTeam({ ...rdeps(dying(["m"])), rechainRole: async () => undefined }, "code", dir, "target");
    expect(out[0].findings[0].note).toMatch(/every model in its chain failed/);
    expect(out[0].findings[0].note).toMatch(/429 quota exceeded/);
  });

  it("renames the row to the model actually serving it once the chain slides", async () => {
    const models: string[] = [];
    await runTeam({ ...rdeps(dying(["m"])), rechainRole: async () => ["healthy-1"] }, "code", dir, "target",
      undefined, (ev) => { if (ev.kind === "agent-model") models.push(ev.model); });
    expect(models).toContain("healthy-1"); // the panel names who is doing the work, not the dead chain head
  });
});

/**
 * Fifteen lenses were each told "review the code for X" and handed read/grep/glob to go and find it — in
 * parallel, each burning its own budget on the same search.
 *
 * Measured over one session: of 85 review failures, 29 said the lens "could not complete" and 13 that its
 * tool-call budget was exhausted. Only four were about the code. Every one of the other 42 sent the task back
 * for a full re-implementation — a twenty-minute attempt spent to answer a question the review never asked.
 */
describe("the code lenses are handed the change", () => {
  const seen = (p: Provider & { requests?: unknown[] }): string =>
    ((p as unknown as { requests: { messages: { content: string }[] }[] }).requests ?? [])
      .map((r) => r.messages.map((m) => m.content).join("\n")).join("\n@@@\n");

  it("puts the diff in the lenses' request", async () => {
    const p = reviewProvider({}) as Provider & { requests: unknown[] };
    const rec: { messages: { content: string }[] }[] = [];
    const spy: Provider = { chat: (req, sig) => { rec.push(req as never); return p.chat(req, sig); } };
    // A real diff, from this repository's own last commit — the shape a lens actually receives.
    await runTeam({ ...rdeps(spy), baseRef: "HEAD~1" }, "code", process.cwd(), "add the store");
    expect(rec.length).toBeGreaterThan(0);
    for (const r of rec) {
      expect(r.messages.map((m) => m.content).join("\n")).toMatch(/diff of this task's changes/);
    }
  });

  /** A document review has no branch to diff — the lens reads the file it was named. */
  it("says nothing about diffs when reviewing a document", async () => {
    const p = reviewProvider({});
    const rec: { messages: { content: string }[] }[] = [];
    const spy: Provider = { chat: (req, sig) => { rec.push(req as never); return p.chat(req, sig); } };
    await runTeam({ ...rdeps(spy), baseRef: "HEAD~1" }, "spec", dir, "spec.md");
    const all = rec.map((r) => r.messages.map((m) => m.content).join("\n")).join("\n");
    expect(all).not.toMatch(/diff of this task's changes/);
  });
});

/**
 * Every task paid the same review, whatever it contained.
 *
 * One small app's task list included "Install all exact dependencies", "Create package.json scripts" and
 * "Add Material M3 theme to angular.json" — three-line edits, each convening fifteen reviewers. The per-task
 * overhead is fixed and the task count is the multiplier.
 */
describe("the review is scaled to the change", () => {
  const diff = (added: number, removed = 0): string =>
    ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,1 +1,1 @@",
      ...Array.from({ length: added }, (_, i) => `+ line ${i}`),
      ...Array.from({ length: removed }, (_, i) => `- old ${i}`)].join("\n");

  it("counts added and removed lines, not the file headers", () => {
    expect(changedLines(diff(3, 2))).toBe(5);
    expect(changedLines("")).toBe(0);
  });

  it("convenes only the core lenses for a small change", () => {
    const chosen = lensesFor(CODE_TEAM, diff(5));
    expect(chosen.length).toBe(CORE_CODE_LENSES.length);
    expect(chosen.every((c) => CORE_CODE_LENSES.includes(c.name))).toBe(true);
  });

  it("convenes the whole team once the change is big enough to hide something", () => {
    expect(lensesFor(CODE_TEAM, diff(SMALL_CHANGE_LINES + 1))).toHaveLength(CODE_TEAM.length);
  });

  /** The four it always runs must actually exist in the shipped team, or the scaling silently does nothing. */
  it("names lenses the shipped team really has", () => {
    for (const n of CORE_CODE_LENSES) expect(CODE_TEAM.map((c) => c.name)).toContain(n);
  });

  /** An unreviewed task is a far worse outcome than an over-reviewed one. */
  it("falls back to the whole team when the size is unknown", () => {
    expect(lensesFor(CODE_TEAM, "")).toHaveLength(CODE_TEAM.length);
    expect(lensesFor(CODE_TEAM, "   ")).toHaveLength(CODE_TEAM.length);
  });

  it("falls back to the whole team when it has been customised past the core names", () => {
    const custom: ReviewerConfig[] = [{ name: "my-lens", perspective: "p", models: ["m"] }];
    expect(lensesFor(custom, diff(2))).toEqual(custom);
  });
});

/**
 * `resolve` throws for a role that was never assigned a model, and it used to throw where nothing caught it:
 * the rejection took down the whole `Promise.all` and the ENTIRE review died in 48ms, failing the task with
 * it. Seen live — one unconfigured lens stopped every review in the run.
 */
describe("a lens with no model is a missing lens, not a broken review", () => {
  const teamOf = (names: string[]): ReviewerConfig[] =>
    names.map((name) => ({ name, perspective: `${name} perspective`, models: ["m"] }));

  it("still reviews with the lenses that do have models", async () => {
    const configured = teamOf(["correctness"]);
    const withGap = [...configured, { name: "no-model", perspective: "gap", models: [] }];
    const d = { ...rdeps(reviewProvider({})), teams: { spec: withGap, plan: withGap, code: withGap },
      teamRegistries: {
        spec: buildTeamRegistry("spec", configured), // the gap lens is absent from the registry entirely
        plan: buildTeamRegistry("plan", configured),
        code: buildTeamRegistry("code", configured),
      } };
    const out = await runTeam(d, "spec", dir, "spec.md");
    expect(out).toHaveLength(2);
    expect(out.some((a) => a.name === "correctness")).toBe(true);
  });

  /** Silently dropping it would let the review approve a dimension nobody checked. */
  it("marks the missing lens's dimension as unverified and blocking", async () => {
    const configured = teamOf(["correctness"]);
    const withGap = [...configured, { name: "no-model", perspective: "gap", models: [] }];
    const d = { ...rdeps(reviewProvider({})), teams: { spec: withGap, plan: withGap, code: withGap },
      teamRegistries: {
        spec: buildTeamRegistry("spec", configured),
        plan: buildTeamRegistry("plan", configured),
        code: buildTeamRegistry("code", configured),
      } };
    const gap = (await runTeam(d, "spec", dir, "spec.md")).find((a) => a.name === "no-model")!;
    expect(gap.recommendation).toBe("revise");
    expect(gap.findings[0].severity).toBe("critical");
    expect(gap.findings[0].note).toMatch(/no model assigned/);
    expect(gap.findings[0].note).toMatch(/roles adjust/);
  });
});

/**
 * The first review used to block on MEDIUM too, and measured on a real board that is what stopped anything
 * from landing: two reviews completed with genuine findings — a mistyped return, an output named like a
 * native event — both medium, and both sent their task back for a FULL re-implementation. A review costs
 * about five minutes and an implementation three, so every medium was an eight-minute round with a fresh
 * chance of another medium next time.
 */
describe("a medium finding does not cost a re-implementation", () => {
  const withFindings = (severity: "medium" | "critical") =>
    reviewProvider({ assessments: { security: JSON.stringify({
      recommendation: "revise", findings: [{ severity, note: `a ${severity} thing` }] }) } });

  it("asks the council to defer mediums on the FIRST attempt, as it always did on later ones", async () => {
    const notes: string[] = [];
    const v = await runCodeReview(rdeps(withFindings("medium")), dir, "add the store", undefined,
      (ev) => { if (ev.kind === "note") notes.push(ev.text); }, 0);
    expect(v.verdict).toBe("pass");
    expect(v.deferred?.length).toBeGreaterThan(0); // carried to the revision pass, not dropped
    expect(notes.join("\n")).toMatch(/whether to defer/);
  });

  /**
   * A CRITICAL never takes the deferral path: it goes to the council, exactly as it did before — the change
   * is about what happens with mediums, and must not quietly soften a blocking finding.
   */
  it("hands a critical finding to the council, which can still send it back", async () => {
    const p = reviewProvider({
      assessments: { security: JSON.stringify({ recommendation: "revise", findings: [{ severity: "critical", note: "a critical thing" }] }) },
      councilVotes: allRevise,
    });
    const notes: string[] = [];
    const v = await runCodeReview(rdeps(p), dir, "add the store", undefined,
      (ev) => { if (ev.kind === "note") notes.push(ev.text); }, 0);
    expect(v.verdict).toBe("fail");
    expect(notes.join("\n")).not.toMatch(/whether to defer/); // never the deferral question
  });

  it("still passes a clean review outright", async () => {
    const v = await runCodeReview(rdeps(reviewProvider({})), dir, "add the store", undefined, () => undefined, 0);
    expect(v.verdict).toBe("pass");
    expect(v.deferred ?? []).toEqual([]);
  });
});
