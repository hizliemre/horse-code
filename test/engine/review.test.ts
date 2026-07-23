import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCouncilRegistry, runCouncil, runJudge, runReviewLoop,
  type ReviewDeps,
} from "../../src/engine/review.js";
import type { CouncilorConfig } from "../../src/config/config.js";
import type { RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-review-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// Content-based deterministic provider: councilor (systemPrompt "perspective") + judge ("P-judge").
export function reviewProvider(opts: { assessments?: Record<string, string>; judge?: string[] }): Provider {
  let judgeCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const emit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
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

export const councilors: CouncilorConfig[] = [
  { name: "security", perspective: "security vulnerabilities", models: ["m"] },
  { name: "arch", perspective: "architectural layers", models: ["m"] },
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
    councilRegistry: buildCouncilRegistry(councilors),
    councilors,
  };
}

describe("buildCouncilRegistry", () => {
  it("converts a councilor into a role; resolve returns the model + perspective prompt", () => {
    const reg = buildCouncilRegistry(councilors);
    const r = reg.resolve("security");
    expect(r.model).toBe("m");
    expect(r.systemPrompt).toContain("security vulnerabilities");
  });
});

describe("runCouncil", () => {
  it("runs the councilors in parallel → named assessments; read-only toolset", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: {
        "security": '{"concerns":["secret leak"],"recommendation":"revise"}',
        "architectural": '{"concerns":[],"recommendation":"approve"}',
      },
    });
    const out = await runCouncil(rdeps(p), dir, "spec.md");
    const byName = Object.fromEntries(out.map((a) => [a.name, a]));
    expect(byName.security.recommendation).toBe("revise");
    expect(byName.security.concerns).toEqual(["secret leak"]);
    expect(byName.arch.recommendation).toBe("approve");
  });

  it("emits councilors as live sub-agents, then clears the panel when done", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: { "security": '{"concerns":[],"recommendation":"approve"}', "architectural": '{"concerns":[],"recommendation":"approve"}' } });
    const events: { kind: string; agents?: { title: string }[] }[] = [];
    await runCouncil(rdeps(p), dir, "spec.md", (ev) => events.push(ev as never));
    const agentEvents = events.filter((e) => e.kind === "agents");
    expect(agentEvents.length).toBe(2); // one to show, one to clear
    expect(agentEvents[0].agents?.map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringContaining("council:")]));
    expect(agentEvents[1].agents).toEqual([]); // cleared on finish
  });

  it("narrates each councilor's finding live (approve ✓ / revise ⚠)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: {
      "security": '{"concerns":["secret leak"],"recommendation":"revise"}',
      "architectural": '{"concerns":[],"recommendation":"approve"}',
    } });
    const notes: string[] = [];
    await runCouncil(rdeps(p), dir, "spec.md", (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(notes.some((n) => /`security`.*⚠.*secret leak/.test(n))).toBe(true); // concern surfaced
    expect(notes.some((n) => /`arch`.*✓/.test(n))).toBe(true); // approval surfaced
  });

  it("councilor toolset is read-only (read/grep/glob/skill; no write/shell)", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const { MockProvider } = await import("../../src/providers/mock.js");
    const p = new MockProvider([
      [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: '{"concerns":[],"recommendation":"approve"}' } },
       { type: "done", finishReason: "tool_calls" }],
    ]);
    const one: CouncilorConfig[] = [{ name: "solo", perspective: "genel", models: ["m"] }];
    const deps: ReviewDeps = { ...rdeps(p), councilRegistry: buildCouncilRegistry(one), councilors: one };
    await runCouncil(deps, dir, "spec.md");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
  });
});

describe("runJudge", () => {
  it("assessments + judge → decision", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["no tests"],"question":""}'] });
    const d = await runJudge(rdeps(p), dir, "spec.md", [
      { name: "security", concerns: ["x"], recommendation: "revise" },
    ]);
    expect(d.decision).toBe("revise");
    expect(d.feedback).toEqual(["no tests"]);
  });
});

describe("runReviewLoop", () => {
  const noRevise = async () => {};
  // Both councilors recommend "revise" → 0% approve < 70% consensus → the judge is consulted.
  const noConsensus = { security: '{"concerns":["x"],"recommendation":"revise"}', arch: '{"concerns":["y"],"recommendation":"revise"}' };

  it("council consensus (≥70% approve) → approved WITHOUT troubling the judge", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    // default assessments = both approve → 100% ≥ 70% → passes on the vote; the judge (would-be revise) never runs
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["ignored"],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("no consensus → judge decides pass → approved, revise not called", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("no consensus → revise(feedback) → second round pass → approved", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"revise","feedback":["no tests"],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(feedbacks).toEqual([["no tests"]]);
  });

  it("ask-human → askUser is called, the answer lands in the next revise feedback → pass", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"ask-human","feedback":["unclear"],"question":"X or Y?"}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    let asked = "";
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async (q) => { asked = q; return "X"; }, 3);
    expect(out.approved).toBe(true);
    expect(asked).toBe("X or Y?");
    expect(feedbacks[0].some((s) => s.includes("X"))).toBe(true);
  });

  it("maxRounds exhausted → final askUser 'approve' → approved; 'stop' → not", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p1 = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const ok = await runReviewLoop(rdeps(p1), dir, "spec.md", noRevise, async () => "approve", 2);
    expect(ok.approved).toBe(true);
    const p2 = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const stop = await runReviewLoop(rdeps(p2), dir, "spec.md", noRevise, async () => "stop", 2);
    expect(stop.approved).toBe(false);
    // negation "I don't approve" (contains "approve") is NOT wrongly counted as approval
    const p3 = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const neg = await runReviewLoop(rdeps(p3), dir, "spec.md", noRevise, async () => "I don't approve", 2);
    expect(neg.approved).toBe(false);
  });

  it("escalation prompt localizes to the user's language (Turkish) + accepts Turkish 'onayla'", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ assessments: noConsensus, judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    let asked = "";
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", noRevise, async (q) => { asked = q; return "onayla"; }, 1, () => {}, "Turkish");
    expect(asked).toMatch(/revizyon turunda onaylanmadı/); // Turkish escalation
    expect(out.approved).toBe(true); // "onayla" counts as approval
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
