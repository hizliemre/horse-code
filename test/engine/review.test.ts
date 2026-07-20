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

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-review-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// İçerik-tabanlı deterministik provider: councilor (systemPrompt "Perspektif") + judge ("P-judge").
export function reviewProvider(opts: { assessments?: Record<string, string>; judge?: string[] }): Provider {
  let judgeCall = 0;
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const emit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      if (sys.includes("Perspektif")) {
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
  { name: "security", perspective: "güvenlik açıkları", models: ["m"] },
  { name: "arch", perspective: "mimari katmanlar", models: ["m"] },
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
    councilRegistry: buildCouncilRegistry(councilors),
    councilors,
  };
}

describe("buildCouncilRegistry", () => {
  it("councilor'ı role'e çevirir; resolve model + perspektif prompt döner", () => {
    const reg = buildCouncilRegistry(councilors);
    const r = reg.resolve("security");
    expect(r.model).toBe("m");
    expect(r.systemPrompt).toContain("güvenlik açıkları");
  });
});

describe("runCouncil", () => {
  it("councilor'ları paralel koşar → isimli assessment'lar; salt-okunur toolset", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({
      assessments: {
        "güvenlik": '{"concerns":["secret sızıntısı"],"recommendation":"revise"}',
        "mimari": '{"concerns":[],"recommendation":"approve"}',
      },
    });
    const out = await runCouncil(rdeps(p), dir, "spec.md");
    const byName = Object.fromEntries(out.map((a) => [a.name, a]));
    expect(byName.security.recommendation).toBe("revise");
    expect(byName.security.concerns).toEqual(["secret sızıntısı"]);
    expect(byName.arch.recommendation).toBe("approve");
  });

  it("councilor toolset salt-okunur (read/grep/glob/skill; write/shell yok)", async () => {
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
  it("assessments + judge → karar", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["testsiz"],"question":""}'] });
    const d = await runJudge(rdeps(p), dir, "spec.md", [
      { name: "security", concerns: ["x"], recommendation: "revise" },
    ]);
    expect(d.decision).toBe("revise");
    expect(d.feedback).toEqual(["testsiz"]);
  });
});

describe("runReviewLoop", () => {
  const noRevise = async () => {};

  it("pass ilk turda → approved, revise çağrılmaz", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    let revised = 0;
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async () => { revised++; }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(revised).toBe(0);
  });

  it("revize → revise(feedback) → ikinci tur pass → approved", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"revise","feedback":["testsiz"],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async () => "x", 3);
    expect(out.approved).toBe(true);
    expect(feedbacks).toEqual([["testsiz"]]);
  });

  it("ask-human → askUser çağrılır, cevap sonraki revise feedback'inde → pass", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = reviewProvider({ judge: ['{"decision":"ask-human","feedback":["belirsiz"],"question":"X mi Y mi?"}', '{"decision":"pass","feedback":[],"question":""}'] });
    const feedbacks: string[][] = [];
    let asked = "";
    const out = await runReviewLoop(rdeps(p), dir, "spec.md", async (f) => { feedbacks.push(f); }, async (q) => { asked = q; return "X"; }, 3);
    expect(out.approved).toBe(true);
    expect(asked).toBe("X mi Y mi?");
    expect(feedbacks[0].some((s) => s.includes("X"))).toBe(true);
  });

  it("maxRounds tükendi → son askUser 'onayla' → approved; 'durdur' → değil", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p1 = reviewProvider({ judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const ok = await runReviewLoop(rdeps(p1), dir, "spec.md", noRevise, async () => "onayla", 2);
    expect(ok.approved).toBe(true);
    const p2 = reviewProvider({ judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const stop = await runReviewLoop(rdeps(p2), dir, "spec.md", noRevise, async () => "durdur", 2);
    expect(stop.approved).toBe(false);
    // olumsuzluk "onaylamıyorum" (içinde "onayla" geçer) yanlışlıkla onay SAYILMAZ
    const p3 = reviewProvider({ judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const neg = await runReviewLoop(rdeps(p3), dir, "spec.md", noRevise, async () => "onaylamıyorum", 2);
    expect(neg.approved).toBe(false);
  });

  it("iptal edilmişse fırlatır", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const ac = new AbortController(); ac.abort();
    const p = reviewProvider({});
    await expect(
      runReviewLoop(rdeps(p, ac.signal), dir, "spec.md", noRevise, async () => "x", 2),
    ).rejects.toThrow();
  });
});
